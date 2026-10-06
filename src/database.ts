import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      service_time INTEGER NOT NULL,
      status TEXT NOT NULL,
      candidates TEXT NOT NULL,
      accepted_staff_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      staff_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      seq INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_one_pending_per_task
      ON invitations(task_id) WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_one_accepted_per_task
      ON invitations(task_id) WHERE status = 'accepted';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_staff_once_per_task
      ON invitations(task_id, staff_id);

    CREATE INDEX IF NOT EXISTS idx_invitations_staff_status
      ON invitations(staff_id, status);
  `);
}
