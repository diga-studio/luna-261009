import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      variants TEXT NOT NULL,
      locked_winner TEXT,
      lock_event_id TEXT,
      lock_stats TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      experiment_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS visitor_state (
      experiment_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      exposed INTEGER NOT NULL DEFAULT 0,
      converted INTEGER NOT NULL DEFAULT 0,
      pending_conversion INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (experiment_id, visitor_id)
    );
  `);
  return db;
}
