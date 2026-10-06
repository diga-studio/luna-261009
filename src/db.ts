import { DatabaseSync } from "node:sqlite";
import { AttachmentRef, BatchStatus, CommitResult, DeclaredFile } from "./types";

export interface BatchRow {
  uploadKey: string;
  ticketId: string;
  declaration: DeclaredFile[];
  status: BatchStatus;
  result: CommitResult | null;
}

export interface ChunkRow {
  fileIndex: number;
  chunkIndex: number;
  sha256: string;
  size: number;
}

export interface ChunkCoordRow {
  uploadKey: string;
  fileIndex: number;
  chunkIndex: number;
}

export interface AttachmentRow {
  attachmentId: string;
  ticketId: string;
  sha256: string;
  size: number;
}

/** SQLite 元数据层：批次、分块记录、已发布附件。 */
export class Db {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        upload_key TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        declaration TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        upload_key TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (upload_key, file_index, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (ticket_id, sha256)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getBatch(uploadKey: string): BatchRow | null {
    const row = this.db
      .prepare("SELECT upload_key, ticket_id, declaration, status, result FROM batches WHERE upload_key = ?")
      .get(uploadKey) as
      | { upload_key: string; ticket_id: string; declaration: string; status: string; result: string | null }
      | undefined;
    if (!row) return null;
    return {
      uploadKey: row.upload_key,
      ticketId: row.ticket_id,
      declaration: JSON.parse(row.declaration) as DeclaredFile[],
      status: row.status as BatchStatus,
      result: row.result ? (JSON.parse(row.result) as CommitResult) : null,
    };
  }

  insertBatch(uploadKey: string, ticketId: string, declaration: DeclaredFile[]): void {
    this.db
      .prepare("INSERT INTO batches (upload_key, ticket_id, declaration, status, result) VALUES (?, ?, ?, 'uploading', NULL)")
      .run(uploadKey, ticketId, JSON.stringify(declaration));
  }

  getChunk(uploadKey: string, fileIndex: number, chunkIndex: number): ChunkRow | null {
    const row = this.db
      .prepare("SELECT file_index, chunk_index, sha256, size FROM chunks WHERE upload_key = ? AND file_index = ? AND chunk_index = ?")
      .get(uploadKey, fileIndex, chunkIndex) as
      | { file_index: number; chunk_index: number; sha256: string; size: number }
      | undefined;
    if (!row) return null;
    return { fileIndex: row.file_index, chunkIndex: row.chunk_index, sha256: row.sha256, size: row.size };
  }

  insertChunk(uploadKey: string, fileIndex: number, chunkIndex: number, sha256: string, size: number): void {
    this.db
      .prepare("INSERT INTO chunks (upload_key, file_index, chunk_index, sha256, size) VALUES (?, ?, ?, ?, ?)")
      .run(uploadKey, fileIndex, chunkIndex, sha256, size);
  }

  listChunks(uploadKey: string): ChunkRow[] {
    const rows = this.db
      .prepare("SELECT file_index, chunk_index, sha256, size FROM chunks WHERE upload_key = ? ORDER BY file_index, chunk_index")
      .all(uploadKey) as Array<{ file_index: number; chunk_index: number; sha256: string; size: number }>;
    return rows.map((r) => ({ fileIndex: r.file_index, chunkIndex: r.chunk_index, sha256: r.sha256, size: r.size }));
  }

  /**
   * 单事务发布批次：附件按 (ticketId, sha256) INSERT OR IGNORE 保证稳定标识，
   * 随后把含附件标识与路径的终结结果写回批次。返回按文件顺序排列的附件行。
   */
  finalizeBatchCommitted(
    uploadKey: string,
    ticketId: string,
    files: Array<{ sha256: string; size: number }>,
    pathFor: (sha256: string) => string,
  ): AttachmentRow[] {
    this.db.exec("BEGIN");
    try {
      const refs: AttachmentRow[] = [];
      for (const f of files) {
        this.db
          .prepare("INSERT OR IGNORE INTO attachments (attachment_id, ticket_id, sha256, size) VALUES (?, ?, ?, ?)")
          .run(newAttachmentId(), ticketId, f.sha256, f.size);
        const row = this.db
          .prepare("SELECT attachment_id, ticket_id, sha256, size FROM attachments WHERE ticket_id = ? AND sha256 = ?")
          .get(ticketId, f.sha256) as { attachment_id: string; ticket_id: string; sha256: string; size: number };
        refs.push({ attachmentId: row.attachment_id, ticketId: row.ticket_id, sha256: row.sha256, size: row.size });
      }
      const attachments: AttachmentRef[] = refs.map((r) => ({ attachmentId: r.attachmentId, path: pathFor(r.sha256) }));
      const result: CommitResult = { status: "committed", attachments };
      this.db
        .prepare("UPDATE batches SET status = 'committed', result = ? WHERE upload_key = ? AND status = 'uploading'")
        .run(JSON.stringify(result), uploadKey);
      this.db.exec("COMMIT");
      return refs;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  finalizeBatchFailed(uploadKey: string, result: CommitResult): void {
    this.db
      .prepare("UPDATE batches SET status = 'failed', result = ? WHERE upload_key = ? AND status = 'uploading'")
      .run(JSON.stringify(result), uploadKey);
  }

  listTicketAttachments(ticketId: string): AttachmentRow[] {
    const rows = this.db
      .prepare("SELECT attachment_id, ticket_id, sha256, size FROM attachments WHERE ticket_id = ? ORDER BY attachment_id")
      .all(ticketId) as Array<{ attachment_id: string; ticket_id: string; sha256: string; size: number }>;
    return rows.map((r) => ({ attachmentId: r.attachment_id, ticketId: r.ticket_id, sha256: r.sha256, size: r.size }));
  }

  /** 所有已发布附件引用的最终文件（sha256 集合），供重开时清理无引用文件。 */
  listReferencedSha256(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT sha256 FROM attachments").all() as Array<{ sha256: string }>;
    return new Set(rows.map((r) => r.sha256));
  }

  /** 仍处于 uploading 状态的批次 key，供重开时区分可续传与终结批次。 */
  listOpenBatchKeys(): Set<string> {
    const rows = this.db.prepare("SELECT upload_key FROM batches WHERE status = 'uploading'").all() as Array<{ upload_key: string }>;
    return new Set(rows.map((r) => r.upload_key));
  }

  listAcceptedChunkCoords(): ChunkCoordRow[] {
    const rows = this.db.prepare("SELECT upload_key, file_index, chunk_index FROM chunks").all() as Array<{
      upload_key: string;
      file_index: number;
      chunk_index: number;
    }>;
    return rows.map((r) => ({ uploadKey: r.upload_key, fileIndex: r.file_index, chunkIndex: r.chunk_index }));
  }

  deleteChunksOfBatch(uploadKey: string): void {
    this.db.prepare("DELETE FROM chunks WHERE upload_key = ?").run(uploadKey);
  }
}

let counter = 0;
function newAttachmentId(): string {
  const hex = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  return `att_${Date.now().toString(36)}_${(counter++).toString(36)}_${hex}`;
}
