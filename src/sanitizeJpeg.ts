import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import type { Writable } from "node:stream";

const MARKER_PREFIX = 0xff;
const CODE_TEM = 0x01;
const CODE_SOI = 0xd8;
const CODE_EOI = 0xd9;
const CODE_SOS = 0xda;
const CODE_DNL = 0xdc;
const CODE_APP1 = 0xe1;
const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] as const;

function isRst(code: number): boolean {
  return code >= 0xd0 && code <= 0xd7;
}

function isStandalone(code: number): boolean {
  return code === CODE_SOI || code === CODE_TEM || isRst(code);
}

const enum Mode {
  Marker,
  MarkerCode,
  Segment,
  Scan,
  ScanCode,
  Tail,
}

function emitFill(count: number, out: Buffer[]): void {
  if (count > 0) out.push(Buffer.alloc(count, MARKER_PREFIX));
}

/**
 * Incremental JPEG parser. Bytes are pushed via `feed`; emitted buffers are
 * the sanitized output stream. APP1 segments whose payload starts with the
 * EXIF signature are dropped; every other byte is forwarded verbatim.
 */
class Sanitizer {
  private mode: Mode = Mode.Marker;
  private ffRun = 0;
  private segCode = 0;
  private segAfter: Mode = Mode.Marker;
  private segParts: Buffer[] = [];
  private segLen = 0;
  private segNeed = -1;

  feed(input: Buffer, out: Buffer[]): void {
    let pos = 0;
    const n = input.length;
    while (pos < n) {
      switch (this.mode) {
        case Mode.Marker: {
          const ff = input.indexOf(MARKER_PREFIX, pos);
          if (ff === -1) {
            out.push(input.subarray(pos));
            pos = n;
          } else {
            if (ff > pos) out.push(input.subarray(pos, ff));
            pos = ff;
            this.ffRun = 0;
            this.mode = Mode.MarkerCode;
          }
          break;
        }
        case Mode.MarkerCode: {
          const b = input[pos]!;
          pos++;
          if (b === MARKER_PREFIX) {
            this.ffRun++;
          } else {
            this.startMarker(b, false, out);
          }
          break;
        }
        case Mode.Segment: {
          const want = (this.segNeed === -1 ? 2 : this.segNeed) - this.segLen;
          const take = Math.min(want, n - pos);
          this.segParts.push(input.subarray(pos, pos + take));
          this.segLen += take;
          pos += take;
          if (this.segNeed === -1 && this.segLen >= 2) {
            const head = Buffer.concat(this.segParts);
            this.segParts = [head];
            this.segNeed = Math.max(2, head.readUInt16BE(0));
          }
          if (this.segNeed !== -1 && this.segLen >= this.segNeed) {
            this.finishSegment(out);
          }
          break;
        }
        case Mode.Scan: {
          const ff = input.indexOf(MARKER_PREFIX, pos);
          if (ff === -1) {
            out.push(input.subarray(pos));
            pos = n;
          } else {
            if (ff > pos) out.push(input.subarray(pos, ff));
            pos = ff;
            this.ffRun = 0;
            this.mode = Mode.ScanCode;
          }
          break;
        }
        case Mode.ScanCode: {
          const b = input[pos]!;
          pos++;
          if (b === MARKER_PREFIX) {
            this.ffRun++;
          } else if (b === 0x00 || b === CODE_TEM || isRst(b)) {
            emitFill(this.ffRun, out);
            out.push(Buffer.from([b]));
            this.mode = Mode.Scan;
          } else {
            this.startMarker(b, true, out);
          }
          break;
        }
        case Mode.Tail: {
          out.push(input.subarray(pos));
          pos = n;
          break;
        }
      }
    }
  }

  finish(out: Buffer[]): void {
    if (this.mode === Mode.MarkerCode || this.mode === Mode.ScanCode) {
      emitFill(this.ffRun, out);
    } else if (this.mode === Mode.Segment && this.segLen > 0) {
      out.push(Buffer.from([MARKER_PREFIX, this.segCode]));
      out.push(Buffer.concat(this.segParts));
      this.segParts = [];
    }
    this.mode = Mode.Tail;
  }

  private startMarker(code: number, inScan: boolean, out: Buffer[]): void {
    emitFill(this.ffRun - 1, out);
    if (code === 0x00) {
      out.push(Buffer.from([MARKER_PREFIX, 0x00]));
      this.mode = inScan ? Mode.Scan : Mode.Marker;
      return;
    }
    if (isStandalone(code)) {
      out.push(Buffer.from([MARKER_PREFIX, code]));
      this.mode = inScan ? Mode.Scan : Mode.Marker;
      return;
    }
    if (code === CODE_EOI) {
      out.push(Buffer.from([MARKER_PREFIX, code]));
      this.mode = Mode.Tail;
      return;
    }
    this.segCode = code;
    this.segAfter =
      code === CODE_SOS || (code === CODE_DNL && inScan) ? Mode.Scan : Mode.Marker;
    this.segParts = [];
    this.segLen = 0;
    this.segNeed = -1;
    this.mode = Mode.Segment;
  }

  private finishSegment(out: Buffer[]): void {
    const seg = Buffer.concat(this.segParts);
    this.segParts = [];
    const payload = seg.subarray(2);
    const isExif =
      this.segCode === CODE_APP1 &&
      payload.length >= EXIF_SIGNATURE.length &&
      EXIF_SIGNATURE.every((b, i) => payload[i] === b);
    if (!isExif) {
      out.push(Buffer.from([MARKER_PREFIX, this.segCode]));
      out.push(seg);
    }
    this.mode = this.segAfter;
  }
}

async function waitDrain(stream: Writable): Promise<void> {
  await Promise.race([
    once(stream, "drain"),
    once(stream, "error").then(([err]) => {
      throw err;
    }),
  ]);
}

async function waitFinish(stream: Writable): Promise<void> {
  await Promise.race([
    once(stream, "finish"),
    once(stream, "error").then(([err]) => {
      throw err;
    }),
  ]);
}

/**
 * Streaming JPEG EXIF sanitizer for the NimbusSync upload pipeline.
 *
 * Removes every APP1 segment whose payload starts with the EXIF signature
 * ("Exif\0\0") and writes all other bytes, in original order, to
 * `destination`. Returns the SHA-256 hex digest of the sanitized bytes.
 */
export async function sanitizeJpeg(
  chunks: AsyncIterable<Uint8Array>,
  destination: string,
): Promise<string> {
  const hash = createHash("sha256");
  const stream = createWriteStream(destination);
  const parser = new Sanitizer();
  const out: Buffer[] = [];
  try {
    for await (const chunk of chunks) {
      const buf = Buffer.from(chunk);
      out.length = 0;
      parser.feed(buf, out);
      for (const piece of out) {
        hash.update(piece);
        if (!stream.write(piece)) await waitDrain(stream);
      }
    }
    out.length = 0;
    parser.finish(out);
    for (const piece of out) {
      hash.update(piece);
      if (!stream.write(piece)) await waitDrain(stream);
    }
    stream.end();
    await waitFinish(stream);
    return hash.digest("hex");
  } catch (err) {
    stream.destroy();
    throw err;
  }
}
