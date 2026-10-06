import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CHUNK_SIZE } from '../src/store';

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `upload-test-${prefix}-`));
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Deterministic pseudo-random bytes so tests are reproducible. */
export function makeBytes(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

export function splitChunks(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    chunks.push(data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length)));
  }
  return chunks;
}

/** Sum of file sizes (bytes) anywhere under dir. */
export function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

/** All file paths under dir, relative and sorted. */
export function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}
