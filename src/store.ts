import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChunkPlan } from "./types.js";

export interface IngestResult {
  size: number;
  sha256: string;
  tmpPath: string;
}

interface StateFile {
  confirmed: number[];
}

/** 持久化层：清单、确认状态与分块数据都落在本地文件系统。 */
export class ChunkStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly storageDir: string) {}

  private fileDir(fileId: string): string {
    return path.join(this.storageDir, encodeURIComponent(fileId));
  }

  private chunksDir(fileId: string): string {
    return path.join(this.fileDir(fileId), "chunks");
  }

  private chunkPath(fileId: string, index: number): string {
    return path.join(this.chunksDir(fileId), String(index));
  }

  private manifestPath(fileId: string): string {
    return path.join(this.fileDir(fileId), "manifest.json");
  }

  private statePath(fileId: string): string {
    return path.join(this.fileDir(fileId), "state.json");
  }

  private tmpPath(fileId: string, index: number): string {
    return path.join(this.fileDir(fileId), "tmp", `${index}-${process.pid}-${Date.now()}`);
  }

  /** 串行化同一 fileId 的写操作，避免并发接收互相干扰。 */
  async withLock<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(fileId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(fileId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(fileId) === next) {
        this.locks.delete(fileId);
      }
    }
  }

  /** 登记清单；重复登记同一 fileId 且内容一致时幂等，不一致则报错。 */
  async registerManifest(plan: ChunkPlan, manifestJson: string): Promise<void> {
    const dir = this.fileDir(plan.fileId);
    const existing = await this.loadPlan(plan.fileId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(plan)) {
        throw new Error(`fileId ${plan.fileId} already registered with a different manifest`);
      }
      return;
    }
    await fs.mkdir(this.chunksDir(plan.fileId), { recursive: true });
    await fs.mkdir(path.join(dir, "tmp"), { recursive: true });
    await this.writeJsonAtomic(this.manifestPath(plan.fileId), { plan, manifest: JSON.parse(manifestJson) });
    if (!(await this.exists(this.statePath(plan.fileId)))) {
      await this.writeJsonAtomic(this.statePath(plan.fileId), { confirmed: [] } satisfies StateFile);
    }
  }

  /** 列出已登记的全部 fileId。 */
  async listFileIds(): Promise<string[]> {
    if (!(await this.exists(this.storageDir))) {
      return [];
    }
    const entries = await fs.readdir(this.storageDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && (await this.exists(this.manifestPath(decodeURIComponent(entry.name))))) {
        ids.push(decodeURIComponent(entry.name));
      }
    }
    return ids.sort();
  }

  /** 读取已登记的清单计划；不存在返回 null。 */
  async loadPlan(fileId: string): Promise<ChunkPlan | null> {
    try {
      const raw = await fs.readFile(this.manifestPath(fileId), "utf8");
      const parsed = JSON.parse(raw) as { plan: ChunkPlan };
      return parsed.plan;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * 已确认分块下标集合。以 state.json 为基础，并与磁盘上的分块文件对账：
   * 只认状态记录且文件存在的分块；状态没有但文件完整存在的（崩溃前已改名）
   * 也会被收养，保证进度既不虚报也不丢失已落盘数据。
   */
  async confirmedIndexes(fileId: string): Promise<Set<number>> {
    const plan = await this.loadPlan(fileId);
    if (!plan) {
      return new Set();
    }
    let state: StateFile = { confirmed: [] };
    try {
      state = JSON.parse(await fs.readFile(this.statePath(fileId), "utf8")) as StateFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    const confirmed = new Set<number>();
    for (const entry of plan.entries) {
      const onDisk = await this.fileSize(this.chunkPath(fileId, entry.index));
      if (onDisk === entry.size) {
        confirmed.add(entry.index);
      }
    }
    const normalized = [...confirmed].sort((a, b) => a - b);
    if (JSON.stringify(normalized) !== JSON.stringify([...state.confirmed].sort((a, b) => a - b))) {
      await this.writeJsonAtomic(this.statePath(fileId), { confirmed: normalized } satisfies StateFile);
    }
    return confirmed;
  }

  async isConfirmed(fileId: string, index: number): Promise<boolean> {
    return (await this.confirmedIndexes(fileId)).has(index);
  }

  /**
   * 把接收到的字节流写入临时文件，同时计算 SHA-256。
   * 返回实际长度与摘要；任何中途失败都会删除临时文件，已确认数据不受影响。
   */
  async ingestToTemp(
    fileId: string,
    index: number,
    stream: AsyncIterable<Uint8Array>,
  ): Promise<IngestResult> {
    const tmp = this.tmpPath(fileId, index);
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const handle = await fs.open(tmp, "w");
    try {
      for await (const chunk of stream) {
        hash.update(chunk);
        size += chunk.byteLength;
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await handle.close();
    return { size, sha256: hash.digest("hex"), tmpPath: tmp };
  }

  /** 校验通过后，把临时文件原子改名为正式分块，并更新状态。 */
  async commitChunk(fileId: string, index: number, tmpPath: string): Promise<void> {
    await fs.rename(tmpPath, this.chunkPath(fileId, index));
    const confirmed = await this.confirmedIndexes(fileId);
    confirmed.add(index);
    await this.writeJsonAtomic(this.statePath(fileId), {
      confirmed: [...confirmed].sort((a, b) => a - b),
    } satisfies StateFile);
  }

  /** 丢弃未通过校验的临时文件。 */
  async discardTemp(tmpPath: string): Promise<void> {
    await fs.rm(tmpPath, { force: true });
  }

  /** 读取已确认分块的内容流。 */
  async readChunk(fileId: string, index: number): Promise<AsyncIterable<Uint8Array>> {
    return createReadStream(this.chunkPath(fileId, index));
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, file);
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  private async fileSize(file: string): Promise<number | null> {
    try {
      return (await fs.stat(file)).size;
    } catch {
      return null;
    }
  }
}
