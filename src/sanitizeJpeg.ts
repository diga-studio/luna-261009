import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const FF = 0xff;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

const enum S {
  Seg, // between segments / before SOI / after EOI: marker expected
  SegFF, // holding one 0xFF (marker prefix candidate) in segment mode
  Len1, // high byte of a length-bearing segment (pass-through)
  Len2, // low byte of a length-bearing segment (pass-through)
  Payload, // pass-through payload, `remaining` bytes left, then -> afterPayload
  App1Len1, // APP1: high length byte (buffered until EXIF decision)
  App1Len2, // APP1: low length byte
  App1Head, // APP1: buffering first payload bytes for the EXIF check
  App1Skip, // APP1 turned out to be EXIF: skipping the rest of the payload
  App1Pass, // APP1 is not EXIF: passing the rest of the payload through
  Scan, // entropy-coded scan data
  ScanFF, // holding one 0xFF inside scan data
}

function isStandaloneMarker(code: number): boolean {
  // SOI, EOI, TEM, RST0-RST7: no length field follows
  return (
    code === 0xd8 ||
    code === 0xd9 ||
    code === 0x01 ||
    (code >= 0xd0 && code <= 0xd7)
  );
}

/**
 * Push-based JPEG structure parser. Bytes are only ever delayed while a
 * decision is pending (one held 0xFF, or an APP1 header of at most 10
 * bytes); everything else flows through in O(1) memory per chunk.
 */
class JpegExifStripper {
  private state: S = S.Seg;
  private afterPayload: S = S.Seg;
  private remaining = 0;
  private lenHigh = 0;
  private app1Buf: number[] = [];
  private out: Uint8Array[] = [];

  process(chunk: Uint8Array): void {
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      switch (this.state) {
        case S.Seg: {
          if (chunk[i] === FF) {
            this.state = S.SegFF;
          } else {
            this.emitSlice(chunk, i, i + 1);
          }
          i++;
          break;
        }
        case S.SegFF: {
          const c = chunk[i];
          i++;
          if (c === FF) {
            // fill byte: the previously held FF is preserved verbatim
            this.emitByte(FF);
          } else {
            this.handleMarkerCode(c);
          }
          break;
        }
        case S.Len1: {
          this.lenHigh = chunk[i];
          this.emitSlice(chunk, i, i + 1);
          this.state = S.Len2;
          i++;
          break;
        }
        case S.Len2: {
          const len = (this.lenHigh << 8) | chunk[i];
          this.emitSlice(chunk, i, i + 1);
          this.remaining = Math.max(0, len - 2);
          this.state = this.remaining > 0 ? S.Payload : this.afterPayload;
          i++;
          break;
        }
        case S.Payload:
        case S.App1Pass: {
          const take = Math.min(this.remaining, n - i);
          this.emitSlice(chunk, i, i + take);
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) {
            this.state = this.state === S.Payload ? this.afterPayload : S.Seg;
          }
          break;
        }
        case S.App1Skip: {
          const take = Math.min(this.remaining, n - i);
          this.remaining -= take;
          i += take;
          if (this.remaining === 0) this.state = S.Seg;
          break;
        }
        case S.App1Len1: {
          this.lenHigh = chunk[i];
          this.app1Buf.push(chunk[i]);
          this.state = S.App1Len2;
          i++;
          break;
        }
        case S.App1Len2: {
          this.app1Buf.push(chunk[i]);
          const len = (this.lenHigh << 8) | chunk[i];
          this.remaining = Math.max(0, len - 2);
          this.state = S.App1Head;
          i++;
          this.finishApp1HeadIfReady();
          break;
        }
        case S.App1Head: {
          const headHave = this.app1Buf.length - 4; // marker(2) + length(2)
          const take = Math.min(6 - headHave, this.remaining, n - i);
          for (let k = 0; k < take; k++) this.app1Buf.push(chunk[i + k]);
          this.remaining -= take;
          i += take;
          this.finishApp1HeadIfReady();
          break;
        }
        case S.Scan: {
          // fast path: copy everything up to the next 0xFF verbatim
          let j = i;
          while (j < n && chunk[j] !== FF) j++;
          if (j > i) this.emitSlice(chunk, i, j);
          i = j;
          if (i < n) {
            this.state = S.ScanFF;
            i++;
          }
          break;
        }
        case S.ScanFF: {
          const c = chunk[i];
          i++;
          if (c === FF) {
            // fill byte inside scan data: preserved, still holding one FF
            this.emitByte(FF);
          } else if (c === 0x00) {
            // escaped data FF
            this.emitByte(FF);
            this.emitByte(0x00);
            this.state = S.Scan;
          } else if (c === 0x01 || (c >= 0xd0 && c <= 0xd7)) {
            // TEM / RST0-RST7: do not end the scan
            this.emitByte(FF);
            this.emitByte(c);
            this.state = S.Scan;
          } else if (c === 0xdc) {
            // DNL: length + payload, then the scan continues
            this.emitByte(FF);
            this.emitByte(0xdc);
            this.afterPayload = S.Scan;
            this.state = S.Len1;
          } else {
            // any other real marker ends the scan
            this.handleMarkerCode(c);
          }
          break;
        }
      }
    }
  }

  end(): void {
    // truncated tail: never lose bytes that were still being held
    if (this.state === S.SegFF || this.state === S.ScanFF) {
      this.emitByte(FF);
    }
    if (this.app1Buf.length > 0) {
      this.emitSlice(Uint8Array.from(this.app1Buf), 0, this.app1Buf.length);
      this.app1Buf = [];
    }
  }

  takeOutput(): Uint8Array[] {
    const pieces = this.out;
    this.out = [];
    return pieces;
  }

  private handleMarkerCode(code: number): void {
    if (code === 0x00 || isStandaloneMarker(code)) {
      // 0x00 is not a marker; standalone markers carry no length
      this.emitByte(FF);
      this.emitByte(code);
      this.state = S.Seg;
      return;
    }
    if (code === 0xe1) {
      // APP1: buffer until we know whether it is EXIF
      this.app1Buf = [FF, 0xe1];
      this.state = S.App1Len1;
      return;
    }
    this.emitByte(FF);
    this.emitByte(code);
    this.afterPayload = code === 0xda ? S.Scan : S.Seg; // SOS opens a scan
    this.state = S.Len1;
  }

  private finishApp1HeadIfReady(): void {
    if (this.state !== S.App1Head) return;
    const headHave = this.app1Buf.length - 4;
    if (headHave < 6 && this.remaining > 0) return; // need more bytes
    const isExif =
      headHave >= 6 &&
      EXIF_HEADER.every((b, idx) => this.app1Buf[4 + idx] === b);
    if (isExif) {
      // drop marker, length and buffered payload; skip the rest
      this.app1Buf = [];
      this.state = this.remaining > 0 ? S.App1Skip : S.Seg;
    } else {
      this.emitSlice(Uint8Array.from(this.app1Buf), 0, this.app1Buf.length);
      this.app1Buf = [];
      this.state = this.remaining > 0 ? S.App1Pass : S.Seg;
    }
  }

  private emitByte(b: number): void {
    this.out.push(Uint8Array.of(b));
  }

  private emitSlice(src: Uint8Array, start: number, end: number): void {
    if (end <= start) return;
    // copy: the caller may reuse chunk buffers across iterations
    this.out.push(src.slice(start, end));
  }
}

/**
 * Removes every real APP1 segment whose payload starts with "Exif\0\0"
 * from a JPEG byte stream, preserving all other bytes (including fill
 * 0xFF bytes, XMP APP1 segments, and look-alike bytes inside scan data).
 *
 * @param chunks async iterable of upload chunks, already re-ordered by the
 *   caller; chunk boundaries may fall between any two bytes
 * @param destination local file path for the sanitized JPEG
 * @returns SHA-256 hex digest of the sanitized bytes
 */
export async function sanitizeJpeg(
  chunks: AsyncIterable<Uint8Array>,
  destination: string,
): Promise<string> {
  const hash = createHash('sha256');
  const stream = createWriteStream(destination);
  const stripper = new JpegExifStripper();

  const flush = async (): Promise<void> => {
    for (const piece of stripper.takeOutput()) {
      hash.update(piece);
      if (!stream.write(piece)) {
        await once(stream, 'drain');
      }
    }
  };

  try {
    for await (const chunk of chunks) {
      stripper.process(chunk);
      await flush();
    }
    stripper.end();
    await flush();
    stream.end();
    await once(stream, 'finish');
    return hash.digest('hex');
  } catch (err) {
    stream.destroy();
    throw err;
  }
}
