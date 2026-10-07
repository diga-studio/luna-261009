import { createHash } from 'node:crypto';
import { FileStore } from './fileStore';
import { AttachmentRow, MetadataStore } from './store';
import {
  BeginResult,
  CHUNK_SIZE,
  ChunkRef,
  CommitResult,
  FileDecl,
  InspectResult,
} from './types';

export type UploadErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'DECLARATION_MISMATCH'
  | 'BATCH_CLOSED'
  | 'CHUNK_CONFLICT'
  | 'INVALID_DECLARATION'
  | 'INVALID_ARGUMENT';

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'UploadError';
  }
}

/** Test-only pause points invoked at persistence boundaries. */
export interface CommitHooks {
  /** After all candidate files are durably staged, before publishing. */
  afterStaging?: () => void;
  /** After final files are in place, before the commit is recorded. */
  beforeCommitRecord?: () => void;
  /** After the commit/failure is recorded, before Commit returns. */
  afterCommitRecord?: () => void;
}

export interface ServiceOptions {
  hooks?: CommitHooks;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function attachmentIdFor(sha256: string): string {
  return `att_${sha256}`;
}

function expectedChunkCount(byteLength: number): number {
  return byteLength === 0 ? 0 : Math.ceil(byteLength / CHUNK_SIZE);
}

function expectedChunkLength(byteLength: number, chunkIndex: number): number {
  const count = expectedChunkCount(byteLength);
  if (chunkIndex === count - 1) {
    const rest = byteLength % CHUNK_SIZE;
    return rest === 0 ? CHUNK_SIZE : rest;
  }
  return CHUNK_SIZE;
}

function normalizeDecl(files: FileDecl[]): string {
  return JSON.stringify(files.map((f) => ({ byteLength: f.byteLength, sha256: f.sha256 })));
}

/**
 * CrashLens screenshot resumable-upload component.
 * Single-process, serial calls only.
 */
export class ScreenshotUploadService {
  private store: MetadataStore;
  private files: FileStore;
  private hooks: CommitHooks;

  constructor(storageDir: string, options: ServiceOptions = {}) {
    this.files = new FileStore(storageDir);
    this.store = new MetadataStore(this.files.rootDir + '/meta.sqlite');
    this.hooks = options.hooks ?? {};
    this.recover();
  }

  /**
   * Reopen recovery: drop artifacts of terminal batches, orphan chunk files,
   * stale staging candidates and unreferenced attachment files. Confirmed
   * chunks of still-open batches are preserved.
   */
  private recover(): void {
    const validChunkPaths = new Set<string>();
    for (const key of this.store.listOpenBatchKeys()) {
      for (const c of this.store.listChunks(key)) {
        validChunkPaths.add(this.files.chunkPath(key, c.fileIndex, c.chunkIndex));
      }
    }
    const referenced = new Set<string>(this.store.listAllAttachmentPaths());
    this.files.sweep(this.store.listTerminalBatchKeys(), validChunkPaths, referenced);
  }

  begin(uploadKey: string, ticketId: string, files: FileDecl[]): BeginResult {
    this.validateDecl(files);
    const existing = this.store.getBatch(uploadKey);
    if (existing) {
      if (existing.ticketId !== ticketId || normalizeDecl(existing.files) !== normalizeDecl(files)) {
        throw new UploadError(
          'DECLARATION_MISMATCH',
          `uploadKey ${uploadKey} already exists with a different declaration`,
        );
      }
      return { uploadKey, ticketId, state: existing.state, reused: true };
    }
    this.store.createBatch(uploadKey, ticketId, files);
    return { uploadKey, ticketId, state: 'open', reused: false };
  }

  putChunk(uploadKey: string, fileIndex: number, chunkIndex: number, bytes: Uint8Array): void {
    const batch = this.store.getBatch(uploadKey);
    if (!batch) throw new UploadError('BATCH_NOT_FOUND', `unknown uploadKey ${uploadKey}`);
    if (batch.state !== 'open') {
      throw new UploadError('BATCH_CLOSED', `batch ${uploadKey} is ${batch.state}`);
    }
    const decl = batch.files[fileIndex];
    if (!decl) {
      throw new UploadError('INVALID_ARGUMENT', `fileIndex ${fileIndex} out of range`);
    }
    const count = expectedChunkCount(decl.byteLength);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count) {
      throw new UploadError('INVALID_ARGUMENT', `chunkIndex ${chunkIndex} out of range (0..${count - 1})`);
    }
    if (bytes.length !== expectedChunkLength(decl.byteLength, chunkIndex)) {
      throw new UploadError(
        'INVALID_ARGUMENT',
        `chunk ${chunkIndex} of file ${fileIndex} must be ${expectedChunkLength(decl.byteLength, chunkIndex)} bytes, got ${bytes.length}`,
      );
    }
    const digest = sha256Hex(bytes);
    const existing = this.store.getChunk(uploadKey, fileIndex, chunkIndex);
    if (existing) {
      if (existing.sha256 === digest && existing.byteLength === bytes.length) {
        return; // identical retry: no-op
      }
      throw new UploadError(
        'CHUNK_CONFLICT',
        `chunk ${chunkIndex} of file ${fileIndex} already accepted with different bytes`,
      );
    }
    const chunk: ChunkRef = { fileIndex, chunkIndex, byteLength: bytes.length, sha256: digest };
    // Persist bytes first, then metadata. A crash in between leaves an orphan
    // file that recovery sweeps; Inspect never claims it as accepted.
    this.files.writeChunk(uploadKey, chunk, bytes);
    this.store.addChunk(uploadKey, chunk);
  }

  commit(uploadKey: string): CommitResult {
    const batch = this.store.getBatch(uploadKey);
    if (!batch) throw new UploadError('BATCH_NOT_FOUND', `unknown uploadKey ${uploadKey}`);
    if (batch.state === 'committed') {
      return { status: 'committed', attachments: batch.commitResult! };
    }
    if (batch.state === 'failed') {
      return { status: 'failed', reason: batch.failureReason! };
    }

    // Check completeness against accepted chunk metadata.
    const accepted = new Set(
      this.store.listChunks(uploadKey).map((c) => `${c.fileIndex}:${c.chunkIndex}`),
    );
    const missing: ChunkRef[] = [];
    batch.files.forEach((decl, fileIndex) => {
      const count = expectedChunkCount(decl.byteLength);
      for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
        if (!accepted.has(`${fileIndex}:${chunkIndex}`)) {
          missing.push({
            fileIndex,
            chunkIndex,
            byteLength: expectedChunkLength(decl.byteLength, chunkIndex),
            sha256: '',
          });
        }
      }
    });
    if (missing.length > 0) return { status: 'incomplete', missing };

    // Assemble and verify every file before publishing anything.
    const staged: { fileIndex: number; stagingPath: string; actualSha256: string }[] = [];
    for (let fileIndex = 0; fileIndex < batch.files.length; fileIndex++) {
      const decl = batch.files[fileIndex];
      const chunkPaths: string[] = [];
      for (let chunkIndex = 0; chunkIndex < expectedChunkCount(decl.byteLength); chunkIndex++) {
        chunkPaths.push(this.files.chunkPath(uploadKey, fileIndex, chunkIndex));
      }
      const stagingPath = this.files.stagingPath(uploadKey, fileIndex);
      const actualSha256 = this.files.assembleFile(chunkPaths, stagingPath);
      staged.push({ fileIndex, stagingPath, actualSha256 });
    }
    this.hooks.afterStaging?.();

    for (const s of staged) {
      const declared = batch.files[s.fileIndex].sha256;
      if (s.actualSha256 !== declared) {
        const reason =
          `sha256 mismatch on file ${s.fileIndex}: declared ${declared}, actual ${s.actualSha256}`;
        this.store.recordFailure(uploadKey, reason);
        this.cleanupBatch(uploadKey);
        this.hooks.afterCommitRecord?.();
        return { status: 'failed', reason };
      }
    }

    // Publish: move every verified candidate into its final, content-addressed
    // location. Attachment identity is deterministic per (ticketId, sha256),
    // so republishing after a crash converges to the same files and ids.
    const rows: AttachmentRow[] = [];
    const result: { attachmentId: string; path: string }[] = [];
    for (const s of staged) {
      const sha256 = batch.files[s.fileIndex].sha256;
      const attachmentId = attachmentIdFor(sha256);
      const finalPath = this.files.attachmentPath(batch.ticketId, attachmentId);
      this.files.publishFile(s.stagingPath, finalPath);
      rows.push({ ticketId: batch.ticketId, sha256, attachmentId, path: finalPath });
      result.push({ attachmentId, path: finalPath });
    }
    this.hooks.beforeCommitRecord?.();

    this.store.recordCommit(uploadKey, rows, result);
    this.cleanupBatch(uploadKey);
    this.hooks.afterCommitRecord?.();
    return { status: 'committed', attachments: result };
  }

  inspect(uploadKey: string): InspectResult {
    const batch = this.store.getBatch(uploadKey);
    if (!batch) throw new UploadError('BATCH_NOT_FOUND', `unknown uploadKey ${uploadKey}`);
    const result: InspectResult = {
      uploadKey,
      ticketId: batch.ticketId,
      state: batch.state,
      acceptedChunks: this.store.listChunks(uploadKey),
      ticketAttachments: this.store
        .listAttachmentsForTicket(batch.ticketId)
        .map((a) => ({ attachmentId: a.attachmentId, path: a.path })),
    };
    if (batch.state === 'committed' && batch.commitResult) {
      result.commitResult = batch.commitResult;
    }
    if (batch.state === 'failed' && batch.failureReason) {
      result.failureReason = batch.failureReason;
    }
    return result;
  }

  private cleanupBatch(uploadKey: string): void {
    try {
      this.files.removeBatchArtifacts(uploadKey);
    } catch {
      // Leftovers are swept on the next reopen; never fail a terminal commit.
    }
  }

  private validateDecl(files: FileDecl[]): void {
    if (!Array.isArray(files) || files.length < 1 || files.length > 5) {
      throw new UploadError('INVALID_DECLARATION', 'a batch must declare 1 to 5 files');
    }
    for (const f of files) {
      if (!Number.isInteger(f.byteLength) || f.byteLength < 0) {
        throw new UploadError('INVALID_DECLARATION', `invalid byteLength ${f.byteLength}`);
      }
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) {
        throw new UploadError('INVALID_DECLARATION', `invalid sha256 ${f.sha256}`);
      }
    }
  }

  close(): void {
    this.store.close();
  }
}
