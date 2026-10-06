import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from './db';
import { ensureLayout, layoutOf, recover, sessionChunkDirName, StorageLayout } from './recovery';
import {
  CompleteResult,
  ConfirmedChunk,
  SessionDeclaration,
  SessionProgress,
  UploadError,
} from './types';

/** Fixed chunk size: 5 MiB. Only the last chunk may be shorter. */
export const CHUNK_SIZE = 5 * 1024 * 1024;

export interface UploadStoreOptions {
  /** Directory holding the SQLite db, chunk data and complete files. */
  dir: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write data to a temp file inside tmpDir, fsync it, then atomically rename. */
function writeFileAtomic(layout: StorageLayout, target: string, data: Buffer): void {
  const tmp = path.join(layout.tmpDir, `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(tmp, target);
  fsyncDir(path.dirname(target));
}

/**
 * Test hook: when UPLOAD_STORE_CRASH_AT lists the given point, the process
 * kills itself, simulating a forced termination at that exact spot.
 * Entries are `point` or `point@n` (only the n-th hit of that point).
 */
const crashCounts = new Map<string, number>();
function maybeCrash(point: string): void {
  const spec = process.env.UPLOAD_STORE_CRASH_AT;
  if (!spec) return;
  const entries = spec.split(',');
  const hit = (crashCounts.get(point) ?? 0) + 1;
  crashCounts.set(point, hit);
  const armed = entries.some((entry) => {
    const [name, at] = entry.split('@');
    return name === point && (at === undefined || Number(at) === hit);
  });
  if (armed) {
    process.kill(process.pid, 'SIGKILL');
  }
}

/**
 * Resumable chunked upload store. Opening the store performs recovery.
 * All methods are synchronous; callers are expected to invoke them serially.
 */
export class UploadStore {
  private readonly layout: StorageLayout;
  private readonly db: Database;

  constructor(options: UploadStoreOptions) {
    this.layout = layoutOf(options.dir);
    ensureLayout(this.layout);
    this.db = new Database(this.layout.dbPath);
    try {
      recover(this.layout, this.db);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private chunkDir(sessionId: string): string {
    return path.join(this.layout.chunksDir, sessionChunkDirName(sessionId));
  }

  private chunkPath(sessionId: string, index: number): string {
    return path.join(this.chunkDir(sessionId), String(index));
  }

  private requireSession(sessionId: string) {
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new UploadError('SESSION_NOT_FOUND', `unknown session: ${sessionId}`);
    }
    return session;
  }

  /**
   * Start a session. Re-starting an existing session with an identical
   * declaration is a no-op; a conflicting declaration is rejected.
   */
  startSession(declaration: SessionDeclaration): SessionProgress {
    const { sessionId, totalSize, sha256 } = declaration;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new UploadError('INVALID_DECLARATION', 'sessionId must be a non-empty string');
    }
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
      throw new UploadError('INVALID_DECLARATION', 'totalSize must be a non-negative safe integer');
    }
    if (!SHA256_HEX.test(sha256)) {
      throw new UploadError('INVALID_DECLARATION', 'sha256 must be 64 lowercase hex characters');
    }
    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);

    const existing = this.db.getSession(sessionId);
    if (existing) {
      if (existing.totalSize !== totalSize || existing.sha256 !== sha256) {
        throw new UploadError(
          'DECLARATION_CONFLICT',
          `session ${sessionId} already exists with a different declaration`,
        );
      }
      return this.getProgress(sessionId);
    }
    this.db.insertSession(sessionId, totalSize, sha256, chunkCount);
    maybeCrash('startSession:afterInsert');
    return this.getProgress(sessionId);
  }

  /**
   * Submit a chunk. Re-submitting identical bytes succeeds without creating
   * another persisted copy; conflicting bytes are rejected, before and after
   * completion.
   */
  submitChunk(sessionId: string, index: number, data: Buffer): ConfirmedChunk {
    const session = this.requireSession(sessionId);
    if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
      throw new UploadError('INVALID_CHUNK_INDEX', `chunk index ${index} out of range`);
    }
    const expectedSize =
      index === session.chunkCount - 1
        ? session.totalSize - CHUNK_SIZE * (session.chunkCount - 1)
        : CHUNK_SIZE;
    if (data.length !== expectedSize) {
      throw new UploadError(
        'INVALID_CHUNK_SIZE',
        `chunk ${index} must be ${expectedSize} bytes, got ${data.length}`,
      );
    }
    const hash = sha256Hex(data);

    const existing = this.db.getChunk(sessionId, index);
    if (existing) {
      if (existing.sha256 !== hash) {
        throw new UploadError(
          'CHUNK_CONFLICT',
          `chunk ${index} of session ${sessionId} was already confirmed with different bytes`,
        );
      }
      return existing;
    }

    writeFileAtomic(this.layout, this.chunkPath(sessionId, index), data);
    maybeCrash('submitChunk:afterFileWrite');
    this.db.insertChunk(sessionId, index, data.length, hash);
    maybeCrash('submitChunk:afterDbInsert');
    return { index, size: data.length, sha256: hash };
  }

  /** Query confirmed progress of a session. */
  getProgress(sessionId: string): SessionProgress {
    const progress = this.db.getProgress(sessionId);
    if (!progress) {
      throw new UploadError('SESSION_NOT_FOUND', `unknown session: ${sessionId}`);
    }
    return progress;
  }

  /**
   * Finish a session: verify all chunks, the total length and the SHA-256,
   * then publish the complete file. Safe to call repeatedly, also across
   * restarts; sessions with identical content share one stored file.
   */
  complete(sessionId: string): CompleteResult {
    const session = this.requireSession(sessionId);

    if (session.completed && session.fileRef !== null) {
      if (!fs.existsSync(session.fileRef)) {
        throw new UploadError('FILE_MISSING', `complete file is missing: ${session.fileRef}`);
      }
      return { fileRef: session.fileRef, sha256: session.sha256, size: session.totalSize };
    }

    const chunks = this.db.listChunks(sessionId);
    if (chunks.length !== session.chunkCount) {
      throw new UploadError(
        'SESSION_INCOMPLETE',
        `session ${sessionId} has ${chunks.length} of ${session.chunkCount} chunks`,
      );
    }

    // Assemble in index order into a staging file while hashing the bytes.
    const stagingPath = path.join(
      this.layout.stagingDir,
      `${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    const hash = crypto.createHash('sha256');
    let total = 0;
    const fd = fs.openSync(stagingPath, 'w');
    try {
      for (const chunk of chunks) {
        const data = fs.readFileSync(this.chunkPath(sessionId, chunk.index));
        if (data.length !== chunk.size) {
          throw new UploadError('INTEGRITY_MISMATCH', `chunk ${chunk.index} has wrong length on disk`);
        }
        hash.update(data);
        total += data.length;
        fs.writeSync(fd, data);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    maybeCrash('complete:afterAssemble');

    const actualSha256 = hash.digest('hex');
    if (total !== session.totalSize || actualSha256 !== session.sha256) {
      fs.rmSync(stagingPath, { force: true });
      throw new UploadError(
        'INTEGRITY_MISMATCH',
        `assembled content does not match the declaration (size ${total}/${session.totalSize}, sha256 ${actualSha256})`,
      );
    }

    // Content-addressed publish: identical content is stored exactly once.
    const finalPath = path.join(this.layout.filesDir, session.sha256);
    if (fs.existsSync(finalPath)) {
      fs.rmSync(stagingPath, { force: true });
    } else {
      fs.renameSync(stagingPath, finalPath);
      // Complete files are immutable.
      fs.chmodSync(finalPath, 0o444);
      fsyncDir(this.layout.filesDir);
    }
    maybeCrash('complete:afterPublish');

    this.db.markCompleted(sessionId, finalPath);
    maybeCrash('complete:afterMarkCompleted');

    // Drop this session's chunk copies, then reconcile the directory:
    // removes leftover temp/staging data and unowned complete files.
    fs.rmSync(this.chunkDir(sessionId), { recursive: true, force: true });
    recover(this.layout, this.db);
    maybeCrash('complete:beforeReturn');

    return { fileRef: finalPath, sha256: session.sha256, size: session.totalSize };
  }
}
