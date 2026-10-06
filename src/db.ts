import { DatabaseSync } from 'node:sqlite';

/**
 * 打开（必要时创建）数据库并初始化 schema。
 * events: 生命周期记录，event_id 全局唯一保证重放幂等。
 * 账单为记录的派生结果，由内存缓存加速，重启后从 events 重建。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      effective_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      plan TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_instance_time
      ON events (instance_id, effective_at);
  `);
  return db;
}
