import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Db } from "./db";
import {
  AttachmentRef,
  CommitOutcome,
  CommitResult,
  CrashHooks,
  DeclaredFile,
  InspectResult,
} from "./types";

export const CHUNK_SIZE = 256 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileAtomicSync(targetPath: string, tmpDir: string, data: Buffer): void {
  const tmp = path.join(tmpDir, `w-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, targetPath);
  fsyncDir(path.dirname(targetPath));
}

/**
 * CrashLens 截图断点续传存储。
 * 元数据在 SQLite（meta.sqlite），分块在 chunks/，最终附件在 attachments/，
 * 中间产物在 tmp/。单进程串行调用。
 */
export class CrashLensStore {
  private readonly dir: string;
  private readonly db: Db;
  private readonly hooks: CrashHooks;
  private readonly chunksDir: string;
  private readonly tmpDir: string;
  private readonly attachmentsDir: string;

  constructor(dir: string, hooks: CrashHooks = {}) {
    this.dir = path.resolve(dir);
    this.hooks = hooks;
    this.chunksDir = path.join(this.dir, "chunks");
    this.tmpDir = path.join(this.dir, "tmp");
    this.attachmentsDir = path.join(this.dir, "attachments");
    for (const d of [this.chunksDir, this.tmpDir, this.attachmentsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    this.db = new Db(path.join(this.dir, "meta.sqlite"));
    this.recover();
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- Begin

  begin(uploadKey: string, ticketId: string, files: DeclaredFile[]): void {
    validateDeclaration(files);
    const existing = this.db.getBatch(uploadKey);
    if (existing) {
      const same =
        existing.ticketId === ticketId &&
        JSON.stringify(existing.declaration) === JSON.stringify(files);
      if (same) return; // 相同 uploadKey + 相同声明：取回原批次（幂等）
      throw new Error(`begin conflict: uploadKey ${uploadKey} already exists with a different declaration`);
    }
    this.db.insertBatch(uploadKey, ticketId, files);
  }

  // ------------------------------------------------------------- PutChunk

  putChunk(uploadKey: string, fileIndex: number, chunkIndex: number, bytes: Buffer): void {
    const batch = this.mustGetBatch(uploadKey);
    if (batch.status !== "uploading") {
      throw new Error(`putChunk rejected: batch ${uploadKey} is ${batch.status}`);
    }
    const expectedSize = this.expectedChunkSize(batch.declaration, fileIndex, chunkIndex);
    if (bytes.length !== expectedSize) {
      throw new Error(
        `putChunk rejected: chunk ${fileIndex}/${chunkIndex} expects ${expectedSize} bytes, got ${bytes.length}`,
      );
    }
    const hash = sha256Hex(bytes);
    const existing = this.db.getChunk(uploadKey, fileIndex, chunkIndex);
    if (existing) {
      if (existing.sha256 === hash) return; // 同位置同字节重试：无副作用
      throw new Error(`putChunk conflict: chunk ${fileIndex}/${chunkIndex} already accepted with different bytes`);
    }
    const batchDir = this.batchChunkDir(uploadKey);
    fs.mkdirSync(batchDir, { recursive: true });
    writeFileAtomicSync(this.chunkPath(uploadKey, fileIndex, chunkIndex), this.tmpDir, bytes);
    this.db.insertChunk(uploadKey, fileIndex, chunkIndex, hash, bytes.length);
    this.hooks.afterChunkPersist?.();
  }

  // --------------------------------------------------------------- Commit

  commit(uploadKey: string): CommitOutcome {
    const batch = this.mustGetBatch(uploadKey);
    if (batch.status !== "uploading") {
      // 终结态不可逆：重复 Commit 返回原终结结果。
      return batch.result as CommitResult;
    }
    const declaration = batch.declaration;
    const accepted = this.db.listChunks(uploadKey);
    const acceptedSet = new Set(accepted.map((c) => `${c.fileIndex}/${c.chunkIndex}`));
    const missing: Array<{ fileIndex: number; chunkIndex: number }> = [];
    for (let fi = 0; fi < declaration.length; fi++) {
      for (let ci = 0; ci < chunkCount(declaration[fi].size); ci++) {
        if (!acceptedSet.has(`${fi}/${ci}`)) missing.push({ fileIndex: fi, chunkIndex: ci });
      }
    }
    if (missing.length > 0) {
      return { status: "incomplete", missing }; // 缺块：保持可续传
    }

    // 逐文件拼装候选并实际校验长度与 SHA-256（不信任声明或既有同摘要附件）。
    const candidates: string[] = [];
    const actual: Array<{ sha256: string; size: number }> = [];
    const fail = (reason: string): CommitResult => {
      const result: CommitResult = { status: "failed", reason };
      this.db.finalizeBatchFailed(uploadKey, result);
      for (const c of candidates) rmQuiet(c);
      this.discardBatchChunks(uploadKey);
      return result;
    };
    for (let fi = 0; fi < declaration.length; fi++) {
      const candidate = path.join(this.tmpDir, `cand-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
      const stat = this.assemble(uploadKey, fi, chunkCount(declaration[fi].size), candidate);
      if (stat.size !== declaration[fi].size || stat.sha256 !== declaration[fi].sha256) {
        rmQuiet(candidate);
        return fail(
          `file ${fi} mismatch: declared size=${declaration[fi].size} sha256=${declaration[fi].sha256}, ` +
            `actual size=${stat.size} sha256=${stat.sha256}`,
        );
      }
      candidates.push(candidate);
      actual.push(stat);
    }

    // 全部校验通过：把候选文件放入附件区（内容寻址，幂等）。
    for (let fi = 0; fi < declaration.length; fi++) {
      const target = this.attachmentPath(actual[fi].sha256);
      if (fs.existsSync(target)) {
        rmQuiet(candidates[fi]); // 同内容最终文件已存在：去重
      } else {
        fs.renameSync(candidates[fi], target);
        fsyncDir(this.attachmentsDir);
      }
    }
    this.hooks.afterFilePersistBeforePublish?.();

    // 单事务发布：附件标识按 (ticketId, sha256) 稳定去重，批次写入终结结果。
    const refs = this.db.finalizeBatchCommitted(uploadKey, batch.ticketId, actual, (s) => this.attachmentPath(s));
    const result: CommitResult = {
      status: "committed",
      attachments: refs.map((r) => ({ attachmentId: r.attachmentId, path: this.attachmentPath(r.sha256) })),
    };
    this.hooks.afterPublishBeforeReturn?.();

    // 终结批次清理（重开时的 recover 是兜底）。
    this.discardBatchChunks(uploadKey);
    return result;
  }

  // -------------------------------------------------------------- Inspect

  inspect(uploadKey: string): InspectResult {
    const batch = this.db.getBatch(uploadKey);
    if (!batch) {
      return { status: "unknown", acceptedChunks: [], ticketAttachments: [] };
    }
    const acceptedChunks = this.db
      .listChunks(uploadKey)
      .map((c) => ({ fileIndex: c.fileIndex, chunkIndex: c.chunkIndex }));
    const ticketAttachments: AttachmentRef[] = this.db.listTicketAttachments(batch.ticketId).map((a) => ({
      attachmentId: a.attachmentId,
      path: this.attachmentPath(a.sha256),
    }));
    const out: InspectResult = { status: batch.status, acceptedChunks, ticketAttachments };
    if (batch.status !== "uploading" && batch.result) out.terminalResult = batch.result;
    return out;
  }

  // ------------------------------------------------------------- 内部实现

  private mustGetBatch(uploadKey: string) {
    const batch = this.db.getBatch(uploadKey);
    if (!batch) throw new Error(`unknown uploadKey: ${uploadKey}`);
    return batch;
  }

  private expectedChunkSize(declaration: DeclaredFile[], fileIndex: number, chunkIndex: number): number {
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= declaration.length) {
      throw new Error(`invalid fileIndex: ${fileIndex}`);
    }
    const size = declaration[fileIndex].size;
    const count = chunkCount(size);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count) {
      throw new Error(`invalid chunkIndex: ${chunkIndex} (file ${fileIndex} has ${count} chunks)`);
    }
    return chunkIndex < count - 1 ? CHUNK_SIZE : size - CHUNK_SIZE * (count - 1);
  }

  private batchChunkDir(uploadKey: string): string {
    return path.join(this.chunksDir, sha256Hex(uploadKey));
  }

  private chunkPath(uploadKey: string, fileIndex: number, chunkIndex: number): string {
    return path.join(this.batchChunkDir(uploadKey), `${fileIndex}-${chunkIndex}.part`);
  }

  private attachmentPath(sha256: string): string {
    return path.join(this.attachmentsDir, sha256);
  }

  /** 按序读取分块拼装候选文件，返回实际长度与 SHA-256。 */
  private assemble(uploadKey: string, fileIndex: number, count: number, candidate: string): { sha256: string; size: number } {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(candidate, "w");
    let size = 0;
    try {
      for (let ci = 0; ci < count; ci++) {
        const data = fs.readFileSync(this.chunkPath(uploadKey, fileIndex, ci));
        hash.update(data);
        fs.writeSync(fd, data);
        size += data.length;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { sha256: hash.digest("hex"), size };
  }

  private discardBatchChunks(uploadKey: string): void {
    rmrfQuiet(this.batchChunkDir(uploadKey));
    this.db.deleteChunksOfBatch(uploadKey);
  }

  /**
   * 重开恢复：
   * - tmp/ 全部删除（写分块临时文件与提交候选文件在崩溃后均无引用）；
   * - 终结/未知批次的分块目录整目录删除；可续传批次中无元数据记录的分块文件删除；
   * - attachments/ 中无元数据引用的最终文件删除。
   */
  private recover(): void {
    for (const name of fs.readdirSync(this.tmpDir)) {
      rmQuiet(path.join(this.tmpDir, name));
    }
    const openDirNames = new Set<string>();
    for (const key of this.db.listOpenBatchKeys()) openDirNames.add(path.basename(this.batchChunkDir(key)));
    const acceptedFiles = new Set<string>();
    for (const c of this.db.listAcceptedChunkCoords()) {
      acceptedFiles.add(`${path.basename(this.batchChunkDir(c.uploadKey))}/${c.fileIndex}-${c.chunkIndex}.part`);
    }
    for (const entry of fs.readdirSync(this.chunksDir)) {
      const batchDir = path.join(this.chunksDir, entry);
      if (!fs.statSync(batchDir).isDirectory()) {
        rmQuiet(batchDir);
        continue;
      }
      if (!openDirNames.has(entry)) {
        rmrfQuiet(batchDir);
        continue;
      }
      for (const f of fs.readdirSync(batchDir)) {
        if (!acceptedFiles.has(`${entry}/${f}`)) rmQuiet(path.join(batchDir, f));
      }
    }
    const referenced = this.db.listReferencedSha256();
    for (const name of fs.readdirSync(this.attachmentsDir)) {
      if (!referenced.has(name)) rmQuiet(path.join(this.attachmentsDir, name));
    }
  }
}

function chunkCount(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
}

function validateDeclaration(files: DeclaredFile[]): void {
  if (!Array.isArray(files) || files.length < 1 || files.length > 5) {
    throw new Error("a batch must declare 1 to 5 files");
  }
  for (const f of files) {
    if (!Number.isInteger(f.size) || f.size < 0) throw new Error(`invalid declared size: ${f.size}`);
    if (!SHA256_RE.test(f.sha256)) throw new Error(`invalid declared sha256: ${f.sha256}`);
  }
}

function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* best effort */
  }
}

function rmrfQuiet(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
