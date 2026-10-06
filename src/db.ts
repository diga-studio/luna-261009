import { DatabaseSync } from 'node:sqlite';
import { ConfirmedChunk, SessionProgress } from './types';

export interface SessionRow {
  sessionId: string;
  totalSize: number;
  sha256: string;
  chunkCount: number;
  completed: boolean;
  fileRef: string | null;
}

interface SessionDbRow {
  session_id: string;
  total_size: number;
  sha256: string;
  chunk_count: number;
  completed: number;
  file_ref: string | null;
}

interface ChunkDbRow {
  idx: number;
  size: number;
  sha256: string;
}

function toSessionRow(row: SessionDbRow): SessionRow {
  return {
    sessionId: row.session_id,
    totalSize: row.total_size,
    sha256: row.sha256,
    chunkCount: row.chunk_count,
    completed: row.completed !== 0,
    fileRef: row.file_ref,
  };
}

function toChunk(row: ChunkDbRow): ConfirmedChunk {
  return { index: row.idx, size: row.size, sha256: row.sha256 };
}

/** Thin wrapper over the SQLite database holding session progress. */
export class Database {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        total_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        file_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        idx INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (session_id, idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a new session declaration. Returns false if it already exists. */
  insertSession(sessionId: string, totalSize: number, sha256: string, chunkCount: number): boolean {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO sessions (session_id, total_size, sha256, chunk_count) VALUES (?, ?, ?, ?)',
    );
    const result = stmt.run(sessionId, totalSize, sha256, chunkCount);
    return Number(result.changes) > 0;
  }

  getSession(sessionId: string): SessionRow | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as SessionDbRow | undefined;
    return row ? toSessionRow(row) : null;
  }

  /** Record a confirmed chunk. Returns false if the (session, index) row exists. */
  insertChunk(sessionId: string, index: number, size: number, sha256: string): boolean {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO chunks (session_id, idx, size, sha256) VALUES (?, ?, ?, ?)',
    );
    const result = stmt.run(sessionId, index, size, sha256);
    return Number(result.changes) > 0;
  }

  getChunk(sessionId: string, index: number): ConfirmedChunk | null {
    const stmt = this.db.prepare('SELECT idx, size, sha256 FROM chunks WHERE session_id = ? AND idx = ?');
    const row = stmt.get(sessionId, index) as ChunkDbRow | undefined;
    return row ? toChunk(row) : null;
  }

  listChunks(sessionId: string): ConfirmedChunk[] {
    const stmt = this.db.prepare('SELECT idx, size, sha256 FROM chunks WHERE session_id = ? ORDER BY idx ASC');
    const rows = stmt.all(sessionId) as unknown as ChunkDbRow[];
    return rows.map(toChunk);
  }

  /** All chunk file locations still expected on disk, across all sessions. */
  listAllChunks(): Array<{ sessionId: string; index: number }> {
    const stmt = this.db.prepare('SELECT session_id, idx FROM chunks');
    const rows = stmt.all() as unknown as Array<{ session_id: string; idx: number }>;
    return rows.map((row) => ({ sessionId: row.session_id, index: row.idx }));
  }

  markCompleted(sessionId: string, fileRef: string): void {
    const stmt = this.db.prepare('UPDATE sessions SET completed = 1, file_ref = ? WHERE session_id = ?');
    stmt.run(fileRef, sessionId);
  }

  listCompletedSessions(): SessionRow[] {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE completed <> 0');
    const rows = stmt.all() as unknown as SessionDbRow[];
    return rows.map(toSessionRow);
  }

  listSessions(): SessionRow[] {
    const stmt = this.db.prepare('SELECT * FROM sessions');
    const rows = stmt.all() as unknown as SessionDbRow[];
    return rows.map(toSessionRow);
  }

  getProgress(sessionId: string): SessionProgress | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      totalSize: session.totalSize,
      sha256: session.sha256,
      chunkCount: session.chunkCount,
      confirmedChunks: this.listChunks(sessionId),
      completed: session.completed,
      ...(session.fileRef !== null ? { fileRef: session.fileRef } : {}),
    };
  }
}
