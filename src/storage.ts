import { createHash } from "node:crypto";
import { randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChunkLayout } from "./types.js";

interface StateFile {
  confirmed: number[];
}

/**
 * 文件级本地存储：负责分块文件与状态文件在磁盘上的读写。
 * 目录结构：<root>/<fileId>/chunks/<index>.part 与 <root>/<fileId>/state.json
 */
export class FileStorage {
  private readonly dir: string;
  private readonly chunksDir: string;
  private readonly statePath: string;
  private readonly confirmed = new Set<number>();
  private readonly stagedPaths = new Map<number, string>();

  private constructor(rootDir: string, fileId: string) {
    this.dir = join(rootDir, fileId);
    this.chunksDir = join(this.dir, "chunks");
    this.statePath = join(this.dir, "state.json");
  }

  /** 打开（必要时创建）存储目录，并从磁盘恢复已确认状态。 */
  static async open(rootDir: string, fileId: string, layout: ChunkLayout[]): Promise<FileStorage> {
    const storage = new FileStorage(rootDir, fileId);
    await mkdir(storage.chunksDir, { recursive: true });

    let persisted: number[] = [];
    try {
      const parsed = JSON.parse(await readFile(storage.statePath, "utf8")) as StateFile;
      if (Array.isArray(parsed.confirmed)) persisted = parsed.confirmed;
    } catch {
      // 状态文件缺失或损坏：视为无已确认分块。
    }

    // 与磁盘实际数据对账：只有分块文件存在且长度符合清单才计入进度。
    for (const index of persisted) {
      const expect = layout[index];
      if (!expect) continue;
      try {
        const info = await stat(storage.chunkPath(index));
        if (info.size === expect.size) {
          storage.confirmed.add(index);
        } else {
          await rm(storage.chunkPath(index), { force: true });
        }
      } catch {
        // 分块文件缺失：不计入进度。
      }
    }
    await storage.persistState();
    return storage;
  }

  isConfirmed(index: number): boolean {
    return this.confirmed.has(index);
  }

  confirmedIndexes(): number[] {
    return [...this.confirmed].sort((a, b) => a - b);
  }

  /**
   * 将数据流写入临时文件并计算 SHA-256；接收中断/出错时清理临时文件。
   * 返回实际字节数与哈希；不改动任何已确认数据。
   */
  async stageChunk(
    index: number,
    source: AsyncIterable<Uint8Array>,
  ): Promise<{ size: number; sha256: string }> {
    const tempPath = join(
      this.chunksDir,
      `.staging-${index}-${process.pid}-${randomInt(0, 1e9)}`,
    );
    const hash = createHash("sha256");
    let size = 0;
    const handle = await open(tempPath, "w");
    try {
      for await (const data of source) {
        hash.update(data);
        size += data.byteLength;
        await handle.write(data);
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
    await handle.close();
    this.stagedPaths.set(index, tempPath);
    return { size, sha256: hash.digest("hex") };
  }

  /** 清理指定分块的临时文件（若存在）。 */
  async discardStaged(index: number): Promise<void> {
    const tempPath = this.stagedPaths.get(index);
    if (tempPath) {
      this.stagedPaths.delete(index);
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  /** 将已验收的临时文件原子落位为正式分块，并持久化状态。 */
  async commitStaged(index: number): Promise<void> {
    const tempPath = this.stagedPaths.get(index);
    if (!tempPath) throw new Error(`no staged chunk for index ${index}`);
    await rename(tempPath, this.chunkPath(index));
    this.stagedPaths.delete(index);
    this.confirmed.add(index);
    await this.persistState();
  }

  /** 按分块顺序流式读取全部已确认分块（仅在完整时调用）。 */
  async *readChunks(layout: ChunkLayout[]): AsyncIterable<Uint8Array> {
    for (const chunk of layout) {
      const stream = createReadStream(this.chunkPath(chunk.index));
      for await (const data of stream) {
        yield data as Uint8Array;
      }
    }
  }

  private chunkPath(index: number): string {
    return join(this.chunksDir, `${index}.part`);
  }

  private async persistState(): Promise<void> {
    const state: StateFile = { confirmed: this.confirmedIndexes() };
    const tempPath = `${this.statePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state));
    await rename(tempPath, this.statePath);
  }
}
