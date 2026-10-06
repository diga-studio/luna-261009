import type { ChunkLayout, FileManifest } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 校验清单合法性，非法时抛错。 */
export function validateManifest(manifest: FileManifest, chunkSize: number): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  const { fileId, totalSize, chunkHashes } = manifest;
  if (typeof fileId !== "string" || !SAFE_FILE_ID.test(fileId) || fileId.includes("..")) {
    throw new Error(`invalid fileId: ${String(fileId)}`);
  }
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new Error(`invalid totalSize: ${String(totalSize)}`);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`invalid chunkSize: ${String(chunkSize)}`);
  }
  if (!Array.isArray(chunkHashes) || chunkHashes.length === 0) {
    throw new Error("chunkHashes must be a non-empty array");
  }
  const expectedChunks = Math.ceil(totalSize / chunkSize);
  if (chunkHashes.length !== expectedChunks) {
    throw new Error(
      `chunkHashes length ${chunkHashes.length} does not match ` +
        `ceil(totalSize/chunkSize) = ${expectedChunks}`,
    );
  }
  for (let i = 0; i < chunkHashes.length; i++) {
    const h = chunkHashes[i];
    if (typeof h !== "string" || !SHA256_HEX.test(h)) {
      throw new Error(`chunkHashes[${i}] is not a lowercase sha256 hex: ${String(h)}`);
    }
  }
}

/** 由清单计算每个分块的布局（偏移、实际长度、预期哈希）。 */
export function computeLayout(manifest: FileManifest, chunkSize: number): ChunkLayout[] {
  const layout: ChunkLayout[] = [];
  const count = manifest.chunkHashes.length;
  for (let index = 0; index < count; index++) {
    const offset = index * chunkSize;
    const size = Math.min(chunkSize, manifest.totalSize - offset);
    layout.push({ index, offset, size, sha256: manifest.chunkHashes[index] });
  }
  return layout;
}
