import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS learners (
  learner_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  content_version TEXT NOT NULL,
  correct INTEGER NOT NULL,
  total INTEGER NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_learner_module
  ON attempts (learner_id, module_id, content_version);

CREATE TABLE IF NOT EXISTS badges (
  learner_id TEXT NOT NULL,
  revision_id INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, revision_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 打开（必要时创建）数据库并确保表结构存在。 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
