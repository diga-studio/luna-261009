import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Database, SessionRow } from "./db";
import { openDatabase } from "./sqlite";
import {
  CHUNK_SIZE,
  ChunkError,
  FileRef,
  IntegrityError,
  Progress,
  SessionError,
} from "./types";
import {
  concatFiles,
  ensureDir,
  fsyncDir,
  removeDirQuiet,
  removeFileQuiet,
  sha256Buffer,
  sha256File,
  writeFileAtomic,
} from "./fsutil";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sessionDirName(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("hex");
}

/**
 * 可恢复分段上传库。
 *
 * 存储目录布局：
 *   <dir>/upload.db            SQLite：会话声明、已确认分段、完成结果
 *   <dir>/chunks/<sess>/<n>    已确认分段（按会话分目录，序号命名）
 *   <dir>/tmp/<rand>           写入/拼接中的临时文件（恢复时清除）
 *   <dir>/files/<sha256>       完整文件（内容寻址、不可改写、跨会话去重）
 *
 * 持久化顺序保证：先落盘文件（fsync + 原子改名），再写 SQLite。
 * 崩溃后重新构造 UploadStore 即完成恢复。
 */
export class UploadStore {
  private readonly dir: string;
  private readonly chunksRoot: string;
  private readonly tmpRoot: string;
  private readonly filesRoot: string;
  private readonly db: Database;

  constructor(dir: string) {
    this.dir = dir;
    this.chunksRoot = path.join(dir, "chunks");
    this.tmpRoot = path.join(dir, "tmp");
    this.filesRoot = path.join(dir, "files");
    ensureDir(this.chunksRoot);
    ensureDir(this.tmpRoot);
    ensureDir(this.filesRoot);
    this.db = new Database(openDatabase(path.join(dir, "upload.db")));
    this.recover();
  }

  /** 开始（或幂等重复开始）一个上传会话。声明一旦建立不可改变。 */
  begin(sessionId: string, totalBytes: number, sha256: string): void {
    this.validateDeclaration(sessionId, totalBytes, sha256);
    const declared = sha256.toLowerCase();
    const existing = this.db.getSession(sessionId);
    if (existing !== null) {
      if (existing.totalBytes !== totalBytes || existing.sha256 !== declared) {
        throw new SessionError(
          `session "${sessionId}" already declared with different totalBytes/sha256`
        );
      }
      return; // 重复开始：不重置进度
    }
    this.db.transaction(() => {
      this.db.insertSession(sessionId, totalBytes, declared);
    });
  }

  /** 提交一个分段。乱序允许；同序号同字节幂等成功；同序号不同字节拒绝。 */
  submitChunk(sessionId: string, chunkIndex: number, data: Buffer): void {
    const session = this.requireSession(sessionId);
    const expectedSize = this.expectedChunkSize(session, chunkIndex);
    if (data.length !== expectedSize) {
      throw new ChunkError(
        `chunk ${chunkIndex} of session "${sessionId}" must be ${expectedSize} bytes, got ${data.length}`
      );
    }
    const digest = sha256Buffer(data);
    const existing = this.db.getChunk(sessionId, chunkIndex);
    if (existing !== null) {
      // 分段记录（含哈希）在完成之后仍保留，因此本规则完成后依然生效。
      if (existing.size === data.length && existing.sha256 === digest) {
        return; // 相同字节重传：成功且不增加持久化副本
      }
      throw new ChunkError(
        `chunk ${chunkIndex} of session "${sessionId}" already confirmed with different bytes`
      );
    }
    const chunkDir = this.chunkDir(sessionId);
    ensureDir(chunkDir);
    const tmpPath = this.newTmpPath();
    // 先完整落盘并原子改名，再登记 SQLite；崩溃只会产生无主临时/分段文件，恢复时清除。
    writeFileAtomic(tmpPath, path.join(chunkDir, String(chunkIndex)), data);
    this.db.transaction(() => {
      this.db.insertChunk({ sessionId, chunkIndex, size: data.length, sha256: digest });
    });
  }

  /** 查询会话进度：已确认分段序号与完成状态。 */
  progress(sessionId: string): Progress {
    const session = this.requireSession(sessionId);
    const confirmedChunks = this.db.getChunks(sessionId).map((c) => c.chunkIndex);
    const progress: Progress = {
      sessionId: session.sessionId,
      totalBytes: session.totalBytes,
      sha256: session.sha256,
      confirmedChunks,
      completed: session.completed,
    };
    if (session.completed && session.filePath !== null) {
      progress.filePath = session.filePath;
    }
    return progress;
  }

  /**
   * 完成上传：全部分段存在、拼接长度与声明一致、实际 SHA-256 匹配才成功。
   * 幂等：重复完成（含跨重启）返回同一引用；同内容会话共享同一份完整文件。
   */
  complete(sessionId: string): FileRef {
    const session = this.requireSession(sessionId);
    if (session.completed && session.filePath !== null) {
      if (!fs.existsSync(session.filePath)) {
        throw new IntegrityError(`completed file missing: ${session.filePath}`);
      }
      return {
        path: session.filePath,
        sha256: session.sha256,
        size: session.totalBytes,
      };
    }

    const chunkCount = this.chunkCount(session.totalBytes);
    const chunks = this.db.getChunks(sessionId);
    const byIndex = new Map(chunks.map((c) => [c.chunkIndex, c]));
    const sourcePaths: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = byIndex.get(index);
      if (chunk === undefined) {
        throw new IntegrityError(
          `session "${sessionId}" is missing chunk ${index} of ${chunkCount}`
        );
      }
      if (chunk.size !== this.expectedChunkSize(session, index)) {
        throw new IntegrityError(
          `session "${sessionId}" chunk ${index} has unexpected size ${chunk.size}`
        );
      }
      sourcePaths.push(path.join(this.chunkDir(sessionId), String(index)));
    }

    // 即使已存在同校验值的完整文件，也必须用本会话的分段重新拼接并通过完整性检查。
    const assembledTmp = this.newTmpPath();
    concatFiles(sourcePaths, assembledTmp);
    const actualSize = fs.statSync(assembledTmp).size;
    if (actualSize !== session.totalBytes) {
      removeFileQuiet(assembledTmp);
      throw new IntegrityError(
        `assembled size ${actualSize} does not match declared ${session.totalBytes}`
      );
    }
    const actualSha = sha256File(assembledTmp);
    if (actualSha !== session.sha256) {
      removeFileQuiet(assembledTmp);
      throw new IntegrityError(
        `assembled sha256 ${actualSha} does not match declared ${session.sha256}`
      );
    }

    const finalPath = path.join(this.filesRoot, session.sha256);
    if (!fs.existsSync(finalPath)) {
      // 先改名入库可见位置，再写 SQLite；崩溃只会产生无主完整文件，恢复时清除。
      fs.renameSync(assembledTmp, finalPath);
      try {
        fs.chmodSync(finalPath, 0o444); // 完整文件不可改写
      } catch {
        // 某些文件系统不支持 chmod，忽略
      }
      fsyncDir(this.filesRoot);
    } else {
      removeFileQuiet(assembledTmp);
    }
    this.db.transaction(() => {
      this.db.markCompleted(sessionId, finalPath);
    });
    // DB 已提交后再清理分段副本；若此处崩溃，恢复时会清理。
    removeDirQuiet(this.chunkDir(sessionId));
    return { path: finalPath, sha256: session.sha256, size: session.totalBytes };
  }

  close(): void {
    this.db.close();
  }

  // ---- 恢复 ----

  /**
   * 重新打开存储目录时恢复：
   * 1. 清除未完成的临时文件（拼接半成品、分段写入半成品）；
   * 2. 清除磁盘上未被 SQLite 确认的分段文件（提交中断的残留）；
   * 3. 清除已完成会话遗留的分段副本（完成后的清理被中断）；
   * 4. 清除未被任何已完成会话引用的无主完整文件。
   * 恢复可再次中断：以上每一步都是幂等的。
   */
  private recover(): void {
    const sessions = this.db.listSessions();
    const knownChunkFiles = new Set<string>();
    for (const chunk of this.db.listAllChunks()) {
      knownChunkFiles.add(
        path.join(this.chunkDir(chunk.sessionId), String(chunk.chunkIndex))
      );
    }

    // 1. 临时文件一律可删：分段写入与拼接都通过原子改名发布。
    for (const entry of fs.readdirSync(this.tmpRoot)) {
      removeFileQuiet(path.join(this.tmpRoot, entry));
    }

    // 2 & 3. 分段目录：删除未确认文件；删除已完成会话的整个分段目录。
    const completedIds = new Set(
      sessions.filter((s) => s.completed).map((s) => s.sessionId)
    );
    for (const entry of fs.readdirSync(this.chunksRoot)) {
      const chunkDir = path.join(this.chunksRoot, entry);
      if (!fs.statSync(chunkDir).isDirectory()) {
        removeFileQuiet(chunkDir);
        continue;
      }
      const sessionId = Buffer.from(entry, "hex").toString("utf8");
      if (completedIds.has(sessionId)) {
        removeDirQuiet(chunkDir);
        continue;
      }
      for (const file of fs.readdirSync(chunkDir)) {
        const filePath = path.join(chunkDir, file);
        if (!knownChunkFiles.has(filePath)) {
          removeFileQuiet(filePath);
        }
      }
    }
    fsyncDir(this.chunksRoot);

    // 4. 无主完整文件。
    const referenced = new Set(
      sessions
        .filter((s) => s.completed && s.filePath !== null)
        .map((s) => path.basename(s.filePath as string))
    );
    for (const entry of fs.readdirSync(this.filesRoot)) {
      if (!referenced.has(entry)) {
        removeFileQuiet(path.join(this.filesRoot, entry));
      }
    }
    fsyncDir(this.filesRoot);
  }

  // ---- 内部助手 ----

  private validateDeclaration(sessionId: string, totalBytes: number, sha256: string): void {
    if (sessionId.length === 0) {
      throw new SessionError("sessionId must not be empty");
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw new SessionError(`totalBytes must be a non-negative integer, got ${totalBytes}`);
    }
    if (!SHA256_HEX.test(sha256.toLowerCase())) {
      throw new SessionError(`sha256 must be 64 hex chars, got "${sha256}"`);
    }
  }

  private requireSession(sessionId: string): SessionRow {
    const session = this.db.getSession(sessionId);
    if (session === null) {
      throw new SessionError(`unknown session "${sessionId}"`);
    }
    return session;
  }

  private chunkCount(totalBytes: number): number {
    return totalBytes === 0 ? 0 : Math.ceil(totalBytes / CHUNK_SIZE);
  }

  private expectedChunkSize(session: SessionRow, chunkIndex: number): number {
    const count = this.chunkCount(session.totalBytes);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count) {
      throw new ChunkError(
        `chunk index ${chunkIndex} out of range [0, ${count}) for session "${session.sessionId}"`
      );
    }
    return Math.min(CHUNK_SIZE, session.totalBytes - chunkIndex * CHUNK_SIZE);
  }

  private chunkDir(sessionId: string): string {
    return path.join(this.chunksRoot, sessionDirName(sessionId));
  }

  private newTmpPath(): string {
    return path.join(this.tmpRoot, crypto.randomBytes(16).toString("hex"));
  }
}
