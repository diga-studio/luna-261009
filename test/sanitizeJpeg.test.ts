import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeJpeg } from '../src/sanitizeJpeg';

// ---------------------------------------------------------------------------
// Sample JPEG construction.
//
// The sample is built from named pieces, each flagged keep/drop. The expected
// sanitizer output is simply the concatenation of the kept pieces, so the
// expectation is correct by construction and independent of the parser.
// ---------------------------------------------------------------------------

function segment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

function bytes(...parts: number[][]): number[] {
  return parts.flat();
}

const EXIF = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP = [...Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1')];

interface Piece {
  name: string;
  keep: boolean;
  data: number[];
}

const pieces: Piece[] = [
  { name: 'SOI', keep: true, data: [0xff, 0xd8] },
  {
    name: 'APP0 JFIF',
    keep: true,
    data: segment(0xe0, [...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  },
  { name: 'fill before EXIF APP1', keep: true, data: [0xff, 0xff, 0xff] },
  {
    name: 'APP1 EXIF with corrupted TIFF body (contains FF D9 inside payload)',
    keep: false,
    data: segment(0xe1, [...EXIF, 0xff, 0xd9, 0xff, 0xda, 0x00, 0x49, 0x49]),
  },
  {
    name: 'APP1 XMP',
    keep: true,
    data: segment(0xe1, [...XMP, ...Buffer.from('<x:xmpmeta/>', 'latin1')]),
  },
  {
    name: 'APP1 pseudo-EXIF (magic not at payload start)',
    keep: true,
    data: segment(0xe1, [0x00, 0x01, ...EXIF, 0x02, 0x03]),
  },
  {
    name: 'APP1 minimal EXIF (payload is exactly the magic)',
    keep: false,
    data: segment(0xe1, [...EXIF]),
  },
  {
    name: 'APP1 short payload "Exif" (too short for magic)',
    keep: true,
    data: segment(0xe1, [0x45, 0x78, 0x69, 0x66]),
  },
  {
    name: 'SOS #1 header',
    keep: true,
    data: segment(0xda, [2, 1, 0x11, 0, 2, 0x11, 0, 0, 63, 0]),
  },
  {
    name: 'scan1: data + escaped FF',
    keep: true,
    data: [0x11, 0x22, 0xff, 0x00, 0x33],
  },
  {
    name: 'scan1: pseudo-EXIF raw bytes in entropy data',
    keep: true,
    data: [...EXIF],
  },
  { name: 'scan1: RST0', keep: true, data: [0xff, 0xd0] },
  { name: 'scan1: fill + RST1', keep: true, data: [0xff, 0xff, 0xff, 0xd1] },
  { name: 'scan1: TEM', keep: true, data: [0xff, 0x01] },
  { name: 'scan1: DNL', keep: true, data: segment(0xdc, [0xaa, 0xbb]) },
  { name: 'scan1: more data', keep: true, data: [0x44, 0x55] },
  { name: 'scan1: fill before inter-scan APP1', keep: true, data: [0xff, 0xff] },
  {
    name: 'APP1 EXIF between scans',
    keep: false,
    data: segment(0xe1, [...EXIF, 0xde, 0xad, 0xbe, 0xef]),
  },
  {
    name: 'DQT between scans',
    keep: true,
    data: segment(0xdb, [0, 1, 2, 3, 4, 5]),
  },
  {
    name: 'SOS #2 header',
    keep: true,
    data: segment(0xda, [1, 1, 0x11, 0, 0, 63, 0]),
  },
  {
    name: 'scan2: data + RST7 + escaped FF at very end',
    keep: true,
    data: [0x77, 0x88, 0xff, 0xd7, 0x99, 0xff, 0x00],
  },
  { name: 'EOI', keep: true, data: [0xff, 0xd9] },
  { name: 'trailing garbage after EOI', keep: true, data: [0x00, 0x11, 0xff] },
];

const input = Uint8Array.from(bytes(...pieces.map((p) => p.data)));
const expected = Uint8Array.from(
  bytes(...pieces.filter((p) => p.keep).map((p) => p.data)),
);
const expectedSha256 = createHash('sha256').update(expected).digest('hex');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkSizes(total: number, size: number): number[] {
  const sizes: number[] = [];
  let left = total;
  while (left > 0) {
    sizes.push(Math.min(size, left));
    left -= sizes[sizes.length - 1];
  }
  return sizes;
}

function randomChunkSizes(total: number, seed: number): number[] {
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  const sizes: number[] = [];
  let left = total;
  while (left > 0) {
    const n = 1 + (rand() % 37);
    sizes.push(Math.min(n, left));
    left -= sizes[sizes.length - 1];
  }
  return sizes;
}

async function* toChunks(data: Uint8Array, sizes: number[]): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (const size of sizes) {
    yield data.subarray(offset, offset + size);
    offset += size;
  }
}

async function runWithChunking(sizes: number[]): Promise<{ hash: string; file: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'jpeg-sanitize-'));
  try {
    const dest = join(dir, 'out.jpg');
    const hash = await sanitizeJpeg(toChunks(input, sizes), dest);
    const file = await readFile(dest);
    return { hash, file };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertSanitized(result: { hash: string; file: Buffer }, context: string): void {
  assert.deepEqual(
    [...result.file],
    [...expected],
    `${context}: sanitized bytes must match expected output exactly`,
  );
  assert.equal(result.hash, expectedSha256, `${context}: SHA-256 must cover sanitized bytes`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('sample actually contains EXIF to remove (sanity)', () => {
  assert.ok(input.length > expected.length);
  assert.notEqual(createHash('sha256').update(input).digest('hex'), expectedSha256);
});

test('single-byte chunks', async () => {
  assertSanitized(await runWithChunking(chunkSizes(input.length, 1)), '1-byte chunks');
});

test('various fixed chunk sizes', async () => {
  for (const size of [2, 3, 4, 5, 7, 8, 13, 16, 64, 256, input.length]) {
    assertSanitized(await runWithChunking(chunkSizes(input.length, size)), `${size}-byte chunks`);
  }
});

test('random chunkings', async () => {
  for (const seed of [1, 42, 1337, 987654]) {
    assertSanitized(await runWithChunking(randomChunkSizes(input.length, seed)), `seed ${seed}`);
  }
});

test('hash covers sanitized bytes, not the uploaded original', async () => {
  const { hash } = await runWithChunking(chunkSizes(input.length, 6));
  assert.equal(hash, expectedSha256);
  assert.notEqual(hash, createHash('sha256').update(input).digest('hex'));
});

test('chunk boundaries inside every marker of a minimal EXIF-only file', async () => {
  const minimal = Uint8Array.from([
    0xff, 0xd8,
    ...segment(0xe1, [...EXIF, 1, 2, 3]),
    0xff, 0xd9,
  ]);
  const minimalExpected = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  for (let size = 1; size <= minimal.length; size++) {
    const dir = await mkdtemp(join(tmpdir(), 'jpeg-sanitize-'));
    try {
      const dest = join(dir, 'out.jpg');
      const hash = await sanitizeJpeg(toChunks(minimal, chunkSizes(minimal.length, size)), dest);
      assert.deepEqual([...await readFile(dest)], [...minimalExpected], `size ${size}`);
      assert.equal(
        hash,
        createHash('sha256').update(minimalExpected).digest('hex'),
        `size ${size}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
