import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { META_GROUPS_KEY, SCHEMA_SQL } from './schema';
import type { ClaimedMessage, GroupDeliveryStatus, PipeLiteOptions } from './types';

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 5;

export class PipeLite {
  private readonly db: DatabaseSync;
  private readonly groups: string[];
  private readonly clock: () => number;
  private lastNow = 0;

  constructor(options: PipeLiteOptions) {
    if (!Array.isArray(options.groups) || options.groups.length < 1 || options.groups.length > 8) {
      throw new RangeError('groups must contain 1 to 8 names');
    }
    if (new Set(options.groups).size !== options.groups.length) {
      throw new Error('group names must be unique');
    }
    this.clock = options.clock;
    this.db = new DatabaseSync(options.path);
    // 不要求异常终止恢复：正常关闭即可保证持久化，换取批量写入性能。
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = OFF');
    this.db.exec(SCHEMA_SQL);

    const stored = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(META_GROUPS_KEY) as { value: string } | undefined;
    if (stored) {
      const persisted = JSON.parse(stored.value) as string[];
      if (JSON.stringify(persisted) !== JSON.stringify(options.groups)) {
        throw new Error('groups do not match the groups stored in this database');
      }
    } else {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(META_GROUPS_KEY, JSON.stringify(options.groups));
    }
    this.groups = [...options.groups];
  }

  /** 当前逻辑时间；对上层时钟做非递减兜底。 */
  private now(): number {
    const t = this.clock();
    if (t > this.lastNow) this.lastNow = t;
    return this.lastNow;
  }

  private begin(): void {
    this.db.exec('BEGIN IMMEDIATE');
  }

  private commit(): void {
    this.db.exec('COMMIT');
  }

  private rollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
  }

  /**
   * 把到期租约落地：前四次超时回到 pending，第五次超时进入 dead。
   * 到期时刻本身已失效（lease_expires_at <= now）。
   */
  private sweep(now: number): void {
    this.db
      .prepare(
        `UPDATE deliveries
           SET state = 'pending', receipt = NULL, lease_expires_at = NULL
         WHERE state = 'leased' AND lease_expires_at <= ? AND attempts < ?`,
      )
      .run(now, MAX_ATTEMPTS);
    this.db
      .prepare(
        `UPDATE deliveries
           SET state = 'dead', receipt = NULL, lease_expires_at = NULL
         WHERE state = 'leased' AND lease_expires_at <= ? AND attempts >= ?`,
      )
      .run(now, MAX_ATTEMPTS);
  }

  private checkGroup(group: string): void {
    if (!this.groups.includes(group)) {
      throw new Error(`unknown group: ${group}`);
    }
  }

  enqueue(payload: unknown, priority: number): number {
    if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
      throw new RangeError('priority must be an integer between 1 and 10');
    }
    const body = JSON.stringify(payload);
    this.begin();
    try {
      const result = this.db
        .prepare('INSERT INTO messages (payload, priority) VALUES (?, ?)')
        .run(body, priority);
      const messageId = Number(result.lastInsertRowid);
      const insertDelivery = this.db.prepare(
        `INSERT INTO deliveries (group_name, message_id, state, attempts)
         VALUES (?, ?, 'pending', 0)`,
      );
      for (const group of this.groups) {
        insertDelivery.run(group, messageId);
      }
      this.commit();
      return messageId;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  claim(group: string, max: number): ClaimedMessage[] {
    this.checkGroup(group);
    if (!Number.isInteger(max) || max < 1 || max > 50) {
      throw new RangeError('max must be an integer between 1 and 50');
    }
    const now = this.now();
    this.begin();
    try {
      this.sweep(now);
      const rows = this.db
        .prepare(
          `SELECT d.message_id AS message_id, m.payload AS payload, m.priority AS priority
             FROM deliveries d
             JOIN messages m ON m.id = d.message_id
            WHERE d.group_name = ? AND d.state = 'pending'
            ORDER BY m.priority DESC, d.message_id ASC
            LIMIT ?`,
        )
        .all(group, max) as Array<{ message_id: number; payload: string; priority: number }>;
      const lease = this.db.prepare(
        `UPDATE deliveries
            SET state = 'leased', attempts = attempts + 1, receipt = ?, lease_expires_at = ?
          WHERE group_name = ? AND message_id = ?`,
      );
      const expiresAt = now + LEASE_MS;
      const claimed: ClaimedMessage[] = [];
      for (const row of rows) {
        const receipt = `${row.message_id}:${group}:${randomUUID()}`;
        lease.run(receipt, expiresAt, group, row.message_id);
        claimed.push({
          messageId: row.message_id,
          payload: JSON.parse(row.payload),
          priority: row.priority,
          receipt,
          expiresAt,
        });
      }
      this.commit();
      return claimed;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  ack(group: string, receipt: string): boolean {
    this.checkGroup(group);
    const now = this.now();
    this.begin();
    try {
      this.sweep(now);
      const row = this.db
        .prepare(
          `SELECT message_id, lease_expires_at
             FROM deliveries
            WHERE group_name = ? AND receipt = ? AND state = 'leased'`,
        )
        .get(group, receipt) as { message_id: number; lease_expires_at: number } | undefined;
      let ok = false;
      if (row && row.lease_expires_at > now) {
        this.db
          .prepare(
            `UPDATE deliveries
                SET state = 'acked', receipt = NULL, lease_expires_at = NULL
              WHERE group_name = ? AND message_id = ?`,
          )
          .run(group, row.message_id);
        ok = true;
      }
      this.commit();
      return ok;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  status(messageId: number): GroupDeliveryStatus[] {
    const now = this.now();
    this.begin();
    try {
      this.sweep(now);
      const rows = this.db
        .prepare(
          `SELECT group_name, state, attempts
             FROM deliveries
            WHERE message_id = ?`,
        )
        .all(messageId) as Array<{ group_name: string; state: string; attempts: number }>;
      this.commit();
      const byGroup = new Map(rows.map((r) => [r.group_name, r]));
      const result: GroupDeliveryStatus[] = [];
      for (const group of this.groups) {
        const row = byGroup.get(group);
        if (row) {
          result.push({
            group,
            state: row.state as GroupDeliveryStatus['state'],
            attempts: row.attempts,
          });
        }
      }
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
