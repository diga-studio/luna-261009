import { DatabaseSync } from "node:sqlite";

/** 打开（必要时创建）数据库并确保表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pass_percent INTEGER NOT NULL CHECK (pass_percent BETWEEN 1 AND 100),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revision_modules (
      revision_id INTEGER NOT NULL REFERENCES revisions(id),
      module_id TEXT NOT NULL,
      content_version TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (revision_id, module_id)
    );
    CREATE TABLE IF NOT EXISTS scores (
      attempt_id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL,
      module_id TEXT NOT NULL,
      content_version TEXT NOT NULL,
      correct INTEGER NOT NULL CHECK (correct >= 0),
      total INTEGER NOT NULL CHECK (total > 0),
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scores_lookup
      ON scores (learner_id, module_id, content_version);
    CREATE TABLE IF NOT EXISTS badges (
      learner_id TEXT NOT NULL,
      revision_id INTEGER NOT NULL REFERENCES revisions(id),
      earned_at TEXT NOT NULL,
      PRIMARY KEY (learner_id, revision_id)
    );
  `);
  return db;
}
