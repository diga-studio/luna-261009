import { StepIndex, type EntityResult } from "../src/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let counter = 0;

export function tempDbPath(): string {
  counter += 1;
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "stepidx-")),
    `idx-${counter}.db`,
  );
}

/** Import `text` into a fresh index, feeding chunks of `chunkSize` bytes. */
export function importText(
  text: string,
  chunkSize: number | number[],
  dbPath = tempDbPath(),
): StepIndex {
  const idx = StepIndex.open(dbPath);
  const imp = idx.beginImport();
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = Array.isArray(chunkSize)
      ? chunkSize[i++ % chunkSize.length]
      : chunkSize;
    const end = Math.min(offset + size, bytes.length);
    imp.write(bytes.subarray(offset, end));
    offset = end;
  }
  imp.finish();
  return idx;
}

/** Deterministic pseudo-random chunk sizes covering 1..n. */
export function irregularChunks(seed: number): number[] {
  const sizes: number[] = [];
  let x = seed;
  for (let i = 0; i < 37; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    sizes.push(1 + (x % 97));
  }
  return sizes;
}

export function dumpAll(idx: StepIndex, ids: string[]): (EntityResult | null)[] {
  return ids.map((id) => idx.getEntity(id));
}
