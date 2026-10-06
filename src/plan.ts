import { DEFAULT_CHUNK_SIZE } from "./types.js";
import type { ChunkPlan, ChunkPlanEntry, FileManifest } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 由清单展开分块计划，并校验清单内部一致性。 */
export function buildChunkPlan(manifest: FileManifest): ChunkPlan {
  if (!manifest || typeof manifest.fileId !== "string" || manifest.fileId.length === 0) {
    throw new Error("manifest.fileId must be a non-empty string");
  }
  if (manifest.fileId.includes("/") || manifest.fileId.includes("\\") || manifest.fileId === "." || manifest.fileId === "..") {
    throw new Error("manifest.fileId must not contain path separators");
  }
  if (!Number.isSafeInteger(manifest.totalSize) || manifest.totalSize < 0) {
    throw new Error("manifest.totalSize must be a non-negative safe integer");
  }
  if (!Array.isArray(manifest.chunks)) {
    throw new Error("manifest.chunks must be an array");
  }

  const chunkSize = manifest.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("manifest.chunkSize must be a positive safe integer");
  }

  const chunkCount = manifest.totalSize === 0 ? 0 : Math.ceil(manifest.totalSize / chunkSize);
  if (manifest.chunks.length !== chunkCount) {
    throw new Error(
      `manifest.chunks length ${manifest.chunks.length} does not match ` +
        `totalSize ${manifest.totalSize} with ${chunkSize}-byte chunks (expected ${chunkCount})`,
    );
  }

  const entries: ChunkPlanEntry[] = [];
  let offset = 0;
  for (let index = 0; index < manifest.chunks.length; index++) {
    const chunk = manifest.chunks[index];
    const isLast = index === manifest.chunks.length - 1;
    const expectedSize = isLast
      ? manifest.totalSize - offset
      : chunkSize;
    const size = chunk.size ?? expectedSize;
    if (!Number.isSafeInteger(size) || size <= 0 || size > chunkSize) {
      throw new Error(`chunk ${index}: size must be in 1..${chunkSize}`);
    }
    if (size !== expectedSize) {
      throw new Error(
        `chunk ${index}: size ${size} inconsistent with totalSize (expected ${expectedSize})`,
      );
    }
    if (typeof chunk.sha256 !== "string" || !SHA256_HEX.test(chunk.sha256)) {
      throw new Error(`chunk ${index}: sha256 must be 64 lowercase hex chars`);
    }
    entries.push({ index, offset, size, sha256: chunk.sha256 });
    offset += size;
  }

  return {
    fileId: manifest.fileId,
    totalSize: manifest.totalSize,
    chunkSize,
    entries,
  };
}
