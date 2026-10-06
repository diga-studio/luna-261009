import type { SqliteDatabase } from "./sqlite";

export interface SessionRow {
  sessionId: string;
  totalBytes: number;
  sha256: string;
  completed: boolean;
  filePath: string | null;
}

export interface ChunkRow {
  sessionId: string;
  chunkIndex: number;
  size: number;
  sha256: string;
}

interface SessionRaw {
  session_id: string;
  total_bytes: number;
  sha256: string;
  completed: number;
  file_path: string | null;
}

interface ChunkRaw {
  session_id: string;
  chunk_index: number;
  size: number;
  sha256: string;
}

function toSession(raw: SessionRaw): SessionRow {
  return {
    sessionId: raw.session_id,
    totalBytes: raw.total_bytes,
    sha256: raw.sha256,
    completed: raw.completed !== 0,
    filePath: raw.file_path,
  };
}

function toChunk(raw: ChunkRaw): ChunkRow {
  return {
    sessionId: raw.session_id,
    chunkIndex: raw.chunk_index,
    size: raw.size,
    sha256: raw.sha256,
  };
}

/** SQLite 持久化层：会话声明、已确认分段、完成结果。 */
export class Database {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        total_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        file_path TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        session_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (session_id, chunk_index)
      );
    `);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRaw | undefined;
    return row === undefined ? null : toSession(row);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare("SELECT * FROM sessions").all() as unknown as SessionRaw[];
    return rows.map(toSession);
  }

  insertSession(sessionId: string, totalBytes: number, sha256: string): void {
    this.db
      .prepare("INSERT INTO sessions (session_id, total_bytes, sha256) VALUES (?, ?, ?)")
      .run(sessionId, totalBytes, sha256);
  }

  markCompleted(sessionId: string, filePath: string): void {
    this.db
      .prepare("UPDATE sessions SET completed = 1, file_path = ? WHERE session_id = ?")
      .run(filePath, sessionId);
  }

  getChunk(sessionId: string, chunkIndex: number): ChunkRow | null {
    const row = this.db
      .prepare("SELECT * FROM chunks WHERE session_id = ? AND chunk_index = ?")
      .get(sessionId, chunkIndex) as ChunkRaw | undefined;
    return row === undefined ? null : toChunk(row);
  }

  getChunks(sessionId: string): ChunkRow[] {
    const rows = this.db
      .prepare("SELECT * FROM chunks WHERE session_id = ? ORDER BY chunk_index ASC")
      .all(sessionId) as unknown as ChunkRaw[];
    return rows.map(toChunk);
  }

  listAllChunks(): ChunkRow[] {
    const rows = this.db.prepare("SELECT * FROM chunks").all() as unknown as ChunkRaw[];
    return rows.map(toChunk);
  }

  insertChunk(chunk: ChunkRow): void {
    this.db
      .prepare(
        "INSERT INTO chunks (session_id, chunk_index, size, sha256) VALUES (?, ?, ?, ?)"
      )
      .run(chunk.sessionId, chunk.chunkIndex, chunk.size, chunk.sha256);
  }

  close(): void {
    this.db.close();
  }
}
