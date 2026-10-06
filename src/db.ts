import { DatabaseSync } from "node:sqlite";

/** 打开（或创建）SQLite 数据库并初始化表结构 */
export function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS variants (
      experiment_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      PRIMARY KEY (experiment_id, variant_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      experiment_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS visitor_states (
      experiment_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      exposed INTEGER NOT NULL DEFAULT 0,
      converted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (experiment_id, visitor_id)
    );
    CREATE TABLE IF NOT EXISTS locks (
      experiment_id TEXT PRIMARY KEY,
      winner_variant_id TEXT NOT NULL,
      trigger_event_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `);
  return db;
}
