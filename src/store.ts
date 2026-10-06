import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { computeLayout, validateManifest } from "./manifest.js";
import { FileStorage } from "./storage.js";
import {
  DEFAULT_CHUNK_SIZE,
  type ChunkLayout,
  type ChunkSource,
  type FileManifest,
  type ReceiveResult,
  type ResumeStatus,
} from "./types.js";

export interface ResumableStoreOptions {
  /** 本地持久化根目录。 */
  dir: string;
  /** 分块大小，默认 64 MiB（仅测试可覆盖）。 */
  chunkSize?: number;
}

interface FileEntry {
  manifest: FileManifest;
  layout: ChunkLayout[];
  storage: FileStorage;
}

/** 大文件校验续传库主入口。 */
export class ResumableStore {
  private readonly dir: string;
  private readonly chunkSize: number;
  private readonly files = new Map<string, FileEntry>();

  constructor(options: ResumableStoreOptions) {
    if (!options || typeof options.dir !== "string" || options.dir.length === 0) {
      throw new Error("options.dir is required");
    }
    this.dir = options.dir;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    validateManifest(
      { fileId: "probe", totalSize: 1, chunkHashes: ["0".repeat(64)] },
      this.chunkSize,
    );
  }

  /** 登记文件清单（幂等）；已存在的登记若清单不一致则抛错。 */
  async registerFile(manifest: FileManifest): Promise<void> {
    validateManifest(manifest, this.chunkSize);

    const existing = this.files.get(manifest.fileId);
    if (existing) {
      assertSameManifest(existing.manifest, manifest);
      return;
    }

    const manifestPath = join(this.dir, manifest.fileId, "manifest.json");
    try {
      const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as FileManifest;
      assertSameManifest(persisted, manifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const layout = computeLayout(manifest, this.chunkSize);
    const storage = await FileStorage.open(this.dir, manifest.fileId, layout);

    const tempPath = `${manifestPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(manifest));
    await rename(tempPath, manifestPath);

    this.files.set(manifest.fileId, { manifest, layout, storage });
  }

  /** 接收单个分块；只有长度与 SHA-256 均符合清单才确认。 */
  async receiveChunk(
    fileId: string,
    index: number,
    source: ChunkSource,
  ): Promise<ReceiveResult> {
    const entry = this.requireEntry(fileId);
    const expect = entry.layout[index];
    if (!expect) {
      throw new Error(`chunk index ${index} out of range for file ${fileId}`);
    }
    const iterable = limitBytes(toAsyncIterable(source), expect.size + 1);

    // 正确的重复提交：已确认位置不再改动，仅消耗流后确认。
    if (entry.storage.isConfirmed(index)) {
      try {
        for await (const _ of iterable) {
          // drain
        }
      } catch {
        // 重复提交的内容不再影响已确认数据，接收异常同样忽略。
      }
      return { accepted: true, duplicate: true };
    }

    let staged: { size: number; sha256: string };
    try {
      staged = await entry.storage.stageChunk(index, iterable);
    } catch (err) {
      return { accepted: false, duplicate: false, reason: `receive failed: ${message(err)}` };
    }

    if (staged.size !== expect.size) {
      await entry.storage.discardStaged(index);
      return {
        accepted: false,
        duplicate: false,
        reason: `size mismatch: got ${staged.size}, expected ${expect.size}`,
      };
    }
    if (staged.sha256 !== expect.sha256) {
      await entry.storage.discardStaged(index);
      return {
        accepted: false,
        duplicate: false,
        reason: "sha256 mismatch",
      };
    }

    await entry.storage.commitStaged(index);
    return { accepted: true, duplicate: false };
  }

  /** 查询续传状态。 */
  async getStatus(fileId: string): Promise<ResumeStatus> {
    const entry = this.requireEntry(fileId);
    const confirmed = new Set(entry.storage.confirmedIndexes());
    const missingChunks: number[] = [];
    let confirmedBytes = 0;
    for (const chunk of entry.layout) {
      if (confirmed.has(chunk.index)) {
        confirmedBytes += chunk.size;
      } else {
        missingChunks.push(chunk.index);
      }
    }
    return {
      fileId,
      totalSize: entry.manifest.totalSize,
      chunkSize: this.chunkSize,
      totalChunks: entry.layout.length,
      confirmedChunks: confirmed.size,
      confirmedBytes,
      missingChunks,
      complete: missingChunks.length === 0,
    };
  }

  /** 全部分块确认后，按清单顺序流式读取完成文件。 */
  async *readFile(fileId: string): AsyncIterable<Uint8Array> {
    const entry = this.requireEntry(fileId);
    const status = await this.getStatus(fileId);
    if (!status.complete) {
      throw new Error(
        `file ${fileId} is incomplete: missing chunks [${status.missingChunks.join(", ")}]`,
      );
    }
    yield* entry.storage.readChunks(entry.layout);
  }

  private requireEntry(fileId: string): FileEntry {
    const entry = this.files.get(fileId);
    if (!entry) {
      throw new Error(`file not registered: ${fileId}`);
    }
    return entry;
  }
}

function assertSameManifest(a: FileManifest, b: FileManifest): void {
  const same =
    a.totalSize === b.totalSize &&
    a.chunkHashes.length === b.chunkHashes.length &&
    a.chunkHashes.every((h, i) => h === b.chunkHashes[i]);
  if (!same) {
    throw new Error(`conflicting manifest for fileId ${b.fileId}`);
  }
}

function toAsyncIterable(source: ChunkSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    return (async function* () {
      yield source;
    })();
  }
  const maybeIterable = source as Partial<AsyncIterable<Uint8Array>>;
  if (typeof maybeIterable[Symbol.asyncIterator] === "function") {
    return maybeIterable as AsyncIterable<Uint8Array>;
  }
  throw new Error("unsupported chunk source: expected Uint8Array or async iterable stream");
}

/** 包装流：超过 limit 字节即报错，避免异常输入撑爆磁盘。 */
async function* limitBytes(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): AsyncIterable<Uint8Array> {
  let seen = 0;
  for await (const data of source) {
    seen += data.byteLength;
    if (seen >= limit) {
      throw new Error(`chunk exceeds expected size (>= ${limit} bytes)`);
    }
    yield data;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
