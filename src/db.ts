import type { LifecycleRecord, Plan } from "./types.js";
import { DatabaseSync } from "node:sqlite";

interface RecordRow {
  event_id: string;
  instance_id: string;
  effective_at: number;
  kind: string;
  plan: string | null;
}

function toRecord(row: RecordRow): LifecycleRecord {
  const rec: LifecycleRecord = {
    eventId: row.event_id,
    instanceId: row.instance_id,
    effectiveAt: row.effective_at,
    kind: row.kind as LifecycleRecord["kind"],
  };
  if (row.plan !== null) rec.plan = row.plan as Plan;
  return rec;
}

/**
 * SQLite 持久层：保存全部生命周期记录，按事件标识去重。
 * 只负责存取，不含计费逻辑。
 */
export class RecordStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt;
  private readonly listStmt;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        event_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        effective_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        plan TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_records_instance_time
        ON records (instance_id, effective_at);
    `);
    this.insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO records (event_id, instance_id, effective_at, kind, plan) VALUES (?, ?, ?, ?, ?)",
    );
    this.listStmt = this.db.prepare(
      "SELECT event_id, instance_id, effective_at, kind, plan FROM records WHERE instance_id = ? ORDER BY effective_at ASC",
    );
  }

  /**
   * 写入一条记录。
   * @returns true 表示是新记录；false 表示相同 eventId 已存在（重放，忽略）。
   */
  insert(record: LifecycleRecord): boolean {
    const result = this.insertStmt.run(
      record.eventId,
      record.instanceId,
      record.effectiveAt,
      record.kind,
      record.kind === "plan" ? (record.plan ?? null) : null,
    );
    return result.changes > 0;
  }

  /**
   * 事务内批量写入。
   * @returns 实际新写入的记录（排除重放）。
   */
  insertBatch(records: LifecycleRecord[]): LifecycleRecord[] {
    const inserted: LifecycleRecord[] = [];
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        if (this.insert(record)) inserted.push(record);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
  }

  /** 按生效时刻升序取出某实例的全部记录。 */
  listByInstance(instanceId: string): LifecycleRecord[] {
    const rows = this.listStmt.all(instanceId) as RecordRow[];
    return rows.map(toRecord);
  }

  /** 关闭数据库连接。 */
  close(): void {
    this.db.close();
  }
}
