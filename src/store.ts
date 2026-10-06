import { DatabaseSync } from 'node:sqlite';
import { BillingEvent, EventKind, Plan } from './types';

interface EventRow {
  event_id: string;
  instance_id: string;
  effective_at: number;
  kind: string;
  plan: string | null;
}

/** 生命周期记录的持久化与查询 */
export class EventStore {
  private insertStmt;
  private stateBeforeStmt;
  private planBeforeStmt;
  private rangeStmt;

  constructor(private db: DatabaseSync) {
    this.insertStmt = db.prepare(
      'INSERT OR IGNORE INTO events (event_id, instance_id, effective_at, kind, plan) VALUES (?, ?, ?, ?, ?)',
    );
    this.stateBeforeStmt = db.prepare(
      `SELECT kind, effective_at FROM events
       WHERE instance_id = ? AND effective_at < ? AND kind IN ('start', 'stop')
       ORDER BY effective_at DESC LIMIT 1`,
    );
    this.planBeforeStmt = db.prepare(
      `SELECT plan, effective_at FROM events
       WHERE instance_id = ? AND effective_at < ? AND kind = 'plan'
       ORDER BY effective_at DESC LIMIT 1`,
    );
    this.rangeStmt = db.prepare(
      `SELECT event_id, instance_id, effective_at, kind, plan FROM events
       WHERE instance_id = ? AND effective_at >= ? AND effective_at < ?
       ORDER BY effective_at ASC`,
    );
  }

  /** 幂等写入；相同 eventId 的重放被忽略。返回是否为首次写入。 */
  insert(event: BillingEvent): boolean {
    const result = this.insertStmt.run(
      event.eventId,
      event.instanceId,
      Math.trunc(event.effectiveAt),
      event.kind,
      event.kind === 'plan' ? (event.plan ?? null) : null,
    );
    return Number(result.changes) > 0;
  }

  /** 某实例在某时刻之前（不含）最近一条启停记录 */
  latestStateBefore(instanceId: string, at: number): { kind: 'start' | 'stop'; effectiveAt: number } | null {
    const row = this.stateBeforeStmt.get(instanceId, at) as
      | { kind: 'start' | 'stop'; effective_at: number }
      | undefined;
    return row ? { kind: row.kind, effectiveAt: row.effective_at } : null;
  }

  /** 某实例在某时刻之前（不含）最近一条套餐记录 */
  latestPlanBefore(instanceId: string, at: number): { plan: Plan; effectiveAt: number } | null {
    const row = this.planBeforeStmt.get(instanceId, at) as
      | { plan: Plan; effective_at: number }
      | undefined;
    return row ? { plan: row.plan, effectiveAt: row.effective_at } : null;
  }

  /** 某实例在 [from, to) 内的全部记录，按生效时刻升序 */
  eventsInRange(instanceId: string, from: number, to: number): BillingEvent[] {
    const rows = this.rangeStmt.all(instanceId, from, to) as unknown as EventRow[];
    return rows.map((row) => ({
      instanceId: row.instance_id,
      eventId: row.event_id,
      effectiveAt: row.effective_at,
      kind: row.kind as EventKind,
      plan: row.plan === null ? undefined : (row.plan as Plan),
    }));
  }
}
