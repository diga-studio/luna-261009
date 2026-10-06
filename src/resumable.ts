import { buildChunkPlan } from "./plan.js";
import { ChunkStore } from "./store.js";
import type { ChunkPlan, FileManifest, ResumeStatus } from "./types.js";

/** 接收单个分块的结果。 */
export type ReceiveResult =
  | { ok: true; alreadyConfirmed: boolean }
  | { ok: false; reason: string };

export class ResumableUpload {
  private readonly store: ChunkStore;

  constructor(storageDir: string) {
    this.store = new ChunkStore(storageDir);
  }

  /** 登记文件清单。清单可信且不可变；同一 fileId 重复登记内容必须一致。 */
  async registerManifest(manifest: FileManifest): Promise<void> {
    const plan = buildChunkPlan(manifest);
    await this.store.registerManifest(plan, JSON.stringify(manifest));
  }

  /** 列出已登记的文件。 */
  async listFiles(): Promise<string[]> {
    return this.store.listFileIds();
  }

  /**
   * 接收一个分块的字节流。只有长度与 SHA-256 都符合清单才确认；
   * 任何失败都不会增加进度，也不损坏已确认数据。
   */
  async receiveChunk(
    fileId: string,
    index: number,
    stream: AsyncIterable<Uint8Array>,
  ): Promise<ReceiveResult> {
    const plan = await this.requirePlan(fileId);
    const entry = plan.entries[index];
    if (!entry) {
      return { ok: false, reason: `chunk index ${index} out of range (0..${plan.entries.length - 1})` };
    }
    return this.store.withLock(fileId, async () => {
      if (await this.store.isConfirmed(fileId, index)) {
        // 已确认的分块：直接忽略重复提交，不覆盖已确认数据。
        return { ok: true, alreadyConfirmed: true };
      }
      let staged;
      try {
        staged = await this.store.ingestToTemp(fileId, index, stream);
      } catch (err) {
        return { ok: false, reason: `receive failed: ${(err as Error).message}` };
      }
      if (staged.size !== entry.size) {
        await this.store.discardTemp(staged.tmpPath);
        return {
          ok: false,
          reason: `chunk ${index}: size mismatch (got ${staged.size}, expected ${entry.size})`,
        };
      }
      if (staged.sha256 !== entry.sha256) {
        await this.store.discardTemp(staged.tmpPath);
        return { ok: false, reason: `chunk ${index}: sha256 mismatch` };
      }
      await this.store.commitChunk(fileId, index, staged.tmpPath);
      return { ok: true, alreadyConfirmed: false };
    });
  }

  /** 查询续传状态。 */
  async getStatus(fileId: string): Promise<ResumeStatus> {
    const plan = await this.requirePlan(fileId);
    const confirmed = await this.store.confirmedIndexes(fileId);
    const missingChunks: number[] = [];
    let confirmedBytes = 0;
    for (const entry of plan.entries) {
      if (confirmed.has(entry.index)) {
        confirmedBytes += entry.size;
      } else {
        missingChunks.push(entry.index);
      }
    }
    return {
      fileId,
      totalSize: plan.totalSize,
      totalChunks: plan.entries.length,
      confirmedChunks: confirmed.size,
      confirmedBytes,
      missingChunks,
      complete: missingChunks.length === 0,
    };
  }

  /**
   * 全部分块确认后，按清单顺序流式读出完成文件。
   * 未完成时抛错。
   */
  async readFile(fileId: string): Promise<AsyncIterable<Uint8Array>> {
    const plan = await this.requirePlan(fileId);
    const status = await this.getStatus(fileId);
    if (!status.complete) {
      throw new Error(
        `file ${fileId} is incomplete: missing chunks [${status.missingChunks.join(", ")}]`,
      );
    }
    const store = this.store;
    return (async function* () {
      for (const entry of plan.entries) {
        yield* (await store.readChunk(fileId, entry.index)) as AsyncIterable<Uint8Array>;
      }
    })();
  }

  private async requirePlan(fileId: string): Promise<ChunkPlan> {
    const plan = await this.store.loadPlan(fileId);
    if (!plan) {
      throw new Error(`fileId ${fileId} is not registered`);
    }
    return plan;
  }
}
