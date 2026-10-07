import { DatabaseSync } from 'node:sqlite';
import { BatchState, ChunkRef, FileDecl } from './types';

export interface BatchRow {
  uploadKey: string;
  ticketId: string;
  files: FileDecl[];
  state: BatchState;
  commitResult: { attachmentId: string; path: string }[] | null;
  failureReason: string | null;
}

export interface AttachmentRow {
  ticketId: string;
  sha256: string;
  attachmentId: string;
  path: string;
}

/** SQLite-backed metadata store. No file bytes are ever stored here. */
export class MetadataStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        upload_key TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        files_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        commit_result_json TEXT,
        failure_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        upload_key TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (upload_key, file_index, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        ticket_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (ticket_id, sha256)
      );
    `);
  }

  getBatch(uploadKey: string): BatchRow | null {
    const row = this.db
      .prepare('SELECT * FROM batches WHERE upload_key = ?')
      .get(uploadKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      uploadKey: row.upload_key as string,
      ticketId: row.ticket_id as string,
      files: JSON.parse(row.files_json as string) as FileDecl[],
      state: row.state as BatchState,
      commitResult: row.commit_result_json
        ? (JSON.parse(row.commit_result_json as string) as { attachmentId: string; path: string }[])
        : null,
      failureReason: (row.failure_reason as string | null) ?? null,
    };
  }

  createBatch(uploadKey: string, ticketId: string, files: FileDecl[]): void {
    this.db
      .prepare('INSERT INTO batches (upload_key, ticket_id, files_json) VALUES (?, ?, ?)')
      .run(uploadKey, ticketId, JSON.stringify(files));
  }

  listChunks(uploadKey: string): ChunkRef[] {
    const rows = this.db
      .prepare(
        'SELECT file_index, chunk_index, byte_length, sha256 FROM chunks WHERE upload_key = ? ORDER BY file_index, chunk_index',
      )
      .all(uploadKey) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      fileIndex: r.file_index as number,
      chunkIndex: r.chunk_index as number,
      byteLength: r.byte_length as number,
      sha256: r.sha256 as string,
    }));
  }

  getChunk(uploadKey: string, fileIndex: number, chunkIndex: number): ChunkRef | null {
    const row = this.db
      .prepare(
        'SELECT file_index, chunk_index, byte_length, sha256 FROM chunks WHERE upload_key = ? AND file_index = ? AND chunk_index = ?',
      )
      .get(uploadKey, fileIndex, chunkIndex) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      fileIndex: row.file_index as number,
      chunkIndex: row.chunk_index as number,
      byteLength: row.byte_length as number,
      sha256: row.sha256 as string,
    };
  }

  addChunk(uploadKey: string, chunk: ChunkRef): void {
    this.db
      .prepare(
        'INSERT INTO chunks (upload_key, file_index, chunk_index, byte_length, sha256) VALUES (?, ?, ?, ?, ?)',
      )
      .run(uploadKey, chunk.fileIndex, chunk.chunkIndex, chunk.byteLength, chunk.sha256);
  }

  /** Atomically record published attachments and mark the batch committed. */
  recordCommit(
    uploadKey: string,
    attachments: AttachmentRow[],
    result: { attachmentId: string; path: string }[],
  ): void {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO attachments (ticket_id, sha256, attachment_id, path) VALUES (?, ?, ?, ?)',
      );
      for (const att of attachments) {
        insert.run(att.ticketId, att.sha256, att.attachmentId, att.path);
      }
      this.db
        .prepare("UPDATE batches SET state = 'committed', commit_result_json = ? WHERE upload_key = ?")
        .run(JSON.stringify(result), uploadKey);
      this.db.prepare('DELETE FROM chunks WHERE upload_key = ?').run(uploadKey);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Atomically mark the batch failed and drop its chunk metadata. */
  recordFailure(uploadKey: string, reason: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare("UPDATE batches SET state = 'failed', failure_reason = ? WHERE upload_key = ?")
        .run(reason, uploadKey);
      this.db.prepare('DELETE FROM chunks WHERE upload_key = ?').run(uploadKey);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listAttachmentsForTicket(ticketId: string): AttachmentRow[] {
    const rows = this.db
      .prepare(
        'SELECT ticket_id, sha256, attachment_id, path FROM attachments WHERE ticket_id = ? ORDER BY rowid',
      )
      .all(ticketId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      ticketId: r.ticket_id as string,
      sha256: r.sha256 as string,
      attachmentId: r.attachment_id as string,
      path: r.path as string,
    }));
  }

  listAllAttachmentPaths(): string[] {
    const rows = this.db
      .prepare('SELECT path FROM attachments')
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => r.path as string);
  }

  /** Upload keys of batches in a terminal state (for chunk/staging sweep). */
  listTerminalBatchKeys(): string[] {
    const rows = this.db
      .prepare("SELECT upload_key FROM batches WHERE state IN ('committed', 'failed')")
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => r.upload_key as string);
  }

  /** Upload keys of batches still resumable. */
  listOpenBatchKeys(): string[] {
    const rows = this.db
      .prepare("SELECT upload_key FROM batches WHERE state = 'open'")
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => r.upload_key as string);
  }

  close(): void {
    this.db.close();
  }
}
