import { createHash } from 'node:crypto';
import { CHUNK_SIZE, FileDecl } from '../../src/types';

/** Deterministic pseudo-random bytes derived from a seed (SHA-256 chain). */
export function makeBytes(seed: number, len: number): Buffer {
  const out = Buffer.alloc(len);
  let block = createHash('sha256').update(`seed:${seed}`).digest();
  let offset = 0;
  while (offset < len) {
    const n = Math.min(block.length, len - offset);
    block.copy(out, offset, 0, n);
    offset += n;
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function declOf(bytes: Uint8Array): FileDecl {
  return { byteLength: bytes.length, sha256: sha256Hex(bytes) };
}

export function chunkOf(bytes: Uint8Array, chunkIndex: number): Buffer {
  const start = chunkIndex * CHUNK_SIZE;
  return Buffer.from(bytes.subarray(start, Math.min(start + CHUNK_SIZE, bytes.length)));
}

export function chunkCount(byteLength: number): number {
  return byteLength === 0 ? 0 : Math.ceil(byteLength / CHUNK_SIZE);
}
