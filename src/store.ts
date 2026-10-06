import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  priority INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  acked INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  lease_expires_at INTEGER,
  PRIMARY KEY (message_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_claim ON deliveries
  (group_id, acked, priority DESC, message_id ASC, attempts, lease_expires_at);
`;

/**
 * SQLite 持久化层：负责打开数据库、设置 pragma、初始化 schema，
 * 并校验消费组配置与已存数据一致。
 *
 * deliveries 在入队时即为每个消费组预建行；idx_claim 让领取查询
 * 只扫描该组尚未确认的行，并直接按 优先级降序 + 入队顺序 输出。
 */
export class Store {
  private readonly database: DatabaseSync;

  constructor(path: string, groups: readonly string[]) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec(SCHEMA);
    this.initGroups(groups);
  }

  private initGroups(groups: readonly string[]): void {
    const get = this.database.prepare("SELECT value FROM meta WHERE key = 'groups'");
    const existing = get.get() as { value: string } | undefined;
    const serialized = JSON.stringify(groups);
    if (existing === undefined) {
      const put = this.database.prepare("INSERT INTO meta (key, value) VALUES ('groups', ?)");
      put.run(serialized);
      return;
    }
    if (existing.value !== serialized) {
      throw new Error(
        `group config mismatch: stored ${existing.value}, requested ${serialized}`,
      );
    }
  }

  get db(): DatabaseSync {
    return this.database;
  }

  /** 在 IMMEDIATE 事务中执行 fn，保证批次内写入要么全部生效要么全部回滚。 */
  transaction<T>(fn: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.database.exec("COMMIT");
      return result;
    } catch (err) {
      this.database.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.database.close();
  }
}
