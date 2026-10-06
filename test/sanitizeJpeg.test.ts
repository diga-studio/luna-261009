import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeJpeg } from "../src/sanitizeJpeg";

const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

function seg(code: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, code, (len >> 8) & 0xff, len & 0xff, ...payload];
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function* chunkify(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    yield data.subarray(i, Math.min(i + size, data.length));
  }
}

async function* chunkifyRandom(data: Uint8Array, seed: number): AsyncGenerator<Uint8Array> {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  let i = 0;
  while (i < data.length) {
    const size = 1 + (rand() % 17);
    yield data.subarray(i, Math.min(i + size, data.length));
    i += size;
  }
}

// --- Sample JPEG with two scans ------------------------------------------------

const app0 = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02]);

// EXIF APP1 with a deliberately corrupted TIFF body: must still be removed.
const exif1 = seg(0xe1, [...EXIF_SIG, 0x49, 0x49, 0xff, 0xff, 0x00, 0x00, 0xde, 0xad]);

const xmp1 = seg(0xe1, [
  ...Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"),
  ...Buffer.from("<x:xmpmeta>first</x:xmpmeta>", "latin1"),
]);

// APP1 whose payload contains the EXIF signature but not at offset 0: kept.
const pseudoExifApp1 = seg(0xe1, [0x00, 0x01, ...EXIF_SIG, 0x02]);

const sos1 = seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);

const scan1 = [
  0x11, 0x22, ...EXIF_SIG, 0x33, // pseudo-EXIF bytes inside entropy data
  0xff, 0x00, 0x44, // escaped FF
  0xff, 0xd0, 0x55, // RST0
  0xff, 0xd7, 0x66, // RST7
  0xff, 0x01, 0x77, // TEM
  0xff, 0xdc, 0x00, 0x04, 0x12, 0x34, // DNL, length 4
  0xff, 0xff, 0xd2, 0x88, // fill FF + RST2
  0x99, 0xaa,
];

// Fill bytes before a deleted APP1 must be preserved.
const fillBeforeExif = [0xff, 0xff, 0xff];
const exif2 = seg(0xe1, [...EXIF_SIG, 0x4d, 0x4d, 0x00]);

const xmp2 = seg(0xe1, [...Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), 0x3c]);

const sos2 = seg(0xda, [0x02, 0x01, 0x11, 0x02, 0x22]);

const scan2 = [0xbb, 0xff, 0x00, 0xcc, 0xff, 0xd3, 0xdd];

const eoi = [0xff, 0xd9];
const trailing = [0x0d, 0x0a]; // garbage after EOI: preserved verbatim

const input = Uint8Array.from([
  0xff, 0xd8,
  ...app0,
  ...exif1,
  ...xmp1,
  ...pseudoExifApp1,
  ...sos1,
  ...scan1,
  ...fillBeforeExif,
  ...exif2,
  ...xmp2,
  ...sos2,
  ...scan2,
  ...eoi,
  ...trailing,
]);

const expected = Uint8Array.from([
  0xff, 0xd8,
  ...app0,
  ...xmp1,
  ...pseudoExifApp1,
  ...sos1,
  ...scan1,
  ...fillBeforeExif,
  ...xmp2,
  ...sos2,
  ...scan2,
  ...eoi,
  ...trailing,
]);

// --- Test harness ---------------------------------------------------------------

async function runCase(
  data: Uint8Array,
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ hash: string; file: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "jpeg-sanitize-"));
  try {
    const dest = join(dir, "out.jpg");
    const hash = await sanitizeJpeg(chunks, dest);
    const file = await readFile(dest);
    return { hash, file };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertResult(result: { hash: string; file: Buffer }, want: Uint8Array): void {
  assert.deepEqual([...result.file], [...want]);
  assert.equal(result.hash, sha256(want));
}

test("removes only real EXIF APP1 segments across many chunkings", async () => {
  const sizes = [1, 2, 3, 5, 7, 16, 64, 1024, input.length];
  for (const size of sizes) {
    const result = await runCase(input, chunkify(input, size));
    assertResult(result, expected);
  }
});

test("random chunk splits produce identical sanitized output", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const result = await runCase(input, chunkifyRandom(input, seed));
    assertResult(result, expected);
  }
});

test("hash covers sanitized bytes, not the uploaded original", async () => {
  const result = await runCase(input, chunkify(input, 9));
  assert.notEqual(result.hash, sha256(input));
  assert.equal(result.hash, sha256(expected));
});

test("JPEG without EXIF passes through byte-identical", async () => {
  const clean = Uint8Array.from([
    0xff, 0xd8,
    ...app0,
    ...xmp1,
    ...sos1,
    ...scan1,
    ...eoi,
  ]);
  for (const size of [1, 4, clean.length]) {
    const result = await runCase(clean, chunkify(clean, size));
    assertResult(result, clean);
  }
});

test("minimal JPEG: SOI + EXIF + EOI collapses to SOI + EOI", async () => {
  const tiny = Uint8Array.from([0xff, 0xd8, ...exif1, 0xff, 0xd9]);
  const want = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  for (const size of [1, 2, tiny.length]) {
    const result = await runCase(tiny, chunkify(tiny, size));
    assertResult(result, want);
  }
});

test("EXIF signature split across chunk boundaries is still removed", async () => {
  // Chunk size 3 cuts the 6-byte signature and the segment length field.
  const data = Uint8Array.from([0xff, 0xd8, ...exif1, ...xmp1, 0xff, 0xd9]);
  const want = Uint8Array.from([0xff, 0xd8, ...xmp1, 0xff, 0xd9]);
  for (const size of [1, 2, 3, 4, 5, 6]) {
    const result = await runCase(data, chunkify(data, size));
    assertResult(result, want);
  }
});
