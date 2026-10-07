"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataStore = void 0;
const node_sqlite_1 = require("node:sqlite");
/** SQLite-backed metadata store. No file bytes are ever stored here. */
class MetadataStore {
    db;
    constructor(dbPath) {
        this.db = new node_sqlite_1.DatabaseSync(dbPath);
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
    getBatch(uploadKey) {
        const row = this.db
            .prepare('SELECT * FROM batches WHERE upload_key = ?')
            .get(uploadKey);
        if (!row)
            return null;
        return {
            uploadKey: row.upload_key,
            ticketId: row.ticket_id,
            files: JSON.parse(row.files_json),
            state: row.state,
            commitResult: row.commit_result_json
                ? JSON.parse(row.commit_result_json)
                : null,
            failureReason: row.failure_reason ?? null,
        };
    }
    createBatch(uploadKey, ticketId, files) {
        this.db
            .prepare('INSERT INTO batches (upload_key, ticket_id, files_json) VALUES (?, ?, ?)')
            .run(uploadKey, ticketId, JSON.stringify(files));
    }
    listChunks(uploadKey) {
        const rows = this.db
            .prepare('SELECT file_index, chunk_index, byte_length, sha256 FROM chunks WHERE upload_key = ? ORDER BY file_index, chunk_index')
            .all(uploadKey);
        return rows.map((r) => ({
            fileIndex: r.file_index,
            chunkIndex: r.chunk_index,
            byteLength: r.byte_length,
            sha256: r.sha256,
        }));
    }
    getChunk(uploadKey, fileIndex, chunkIndex) {
        const row = this.db
            .prepare('SELECT file_index, chunk_index, byte_length, sha256 FROM chunks WHERE upload_key = ? AND file_index = ? AND chunk_index = ?')
            .get(uploadKey, fileIndex, chunkIndex);
        if (!row)
            return null;
        return {
            fileIndex: row.file_index,
            chunkIndex: row.chunk_index,
            byteLength: row.byte_length,
            sha256: row.sha256,
        };
    }
    addChunk(uploadKey, chunk) {
        this.db
            .prepare('INSERT INTO chunks (upload_key, file_index, chunk_index, byte_length, sha256) VALUES (?, ?, ?, ?, ?)')
            .run(uploadKey, chunk.fileIndex, chunk.chunkIndex, chunk.byteLength, chunk.sha256);
    }
    /** Atomically record published attachments and mark the batch committed. */
    recordCommit(uploadKey, attachments, result) {
        this.db.exec('BEGIN');
        try {
            const insert = this.db.prepare('INSERT OR IGNORE INTO attachments (ticket_id, sha256, attachment_id, path) VALUES (?, ?, ?, ?)');
            for (const att of attachments) {
                insert.run(att.ticketId, att.sha256, att.attachmentId, att.path);
            }
            this.db
                .prepare("UPDATE batches SET state = 'committed', commit_result_json = ? WHERE upload_key = ?")
                .run(JSON.stringify(result), uploadKey);
            this.db.prepare('DELETE FROM chunks WHERE upload_key = ?').run(uploadKey);
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
    /** Atomically mark the batch failed and drop its chunk metadata. */
    recordFailure(uploadKey, reason) {
        this.db.exec('BEGIN');
        try {
            this.db
                .prepare("UPDATE batches SET state = 'failed', failure_reason = ? WHERE upload_key = ?")
                .run(reason, uploadKey);
            this.db.prepare('DELETE FROM chunks WHERE upload_key = ?').run(uploadKey);
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
    listAttachmentsForTicket(ticketId) {
        const rows = this.db
            .prepare('SELECT ticket_id, sha256, attachment_id, path FROM attachments WHERE ticket_id = ? ORDER BY rowid')
            .all(ticketId);
        return rows.map((r) => ({
            ticketId: r.ticket_id,
            sha256: r.sha256,
            attachmentId: r.attachment_id,
            path: r.path,
        }));
    }
    listAllAttachmentPaths() {
        const rows = this.db
            .prepare('SELECT path FROM attachments')
            .all();
        return rows.map((r) => r.path);
    }
    /** Upload keys of batches in a terminal state (for chunk/staging sweep). */
    listTerminalBatchKeys() {
        const rows = this.db
            .prepare("SELECT upload_key FROM batches WHERE state IN ('committed', 'failed')")
            .all();
        return rows.map((r) => r.upload_key);
    }
    /** Upload keys of batches still resumable. */
    listOpenBatchKeys() {
        const rows = this.db
            .prepare("SELECT upload_key FROM batches WHERE state = 'open'")
            .all();
        return rows.map((r) => r.upload_key);
    }
    close() {
        this.db.close();
    }
}
exports.MetadataStore = MetadataStore;
