import { openDatabase } from './db';
import { EventStore } from './store';
import {
  computeMonthlyBillColumns,
  KIND_PLAN,
  KIND_START,
  KIND_STOP,
  PLAN_INDEX,
  PLAN_MICRO_DOLLARS_PER_HOUR,
} from './billing';
import { BillingEvent, MonthlyBill, Plan } from './types';

const VALID_PLANS = new Set<string>(['Small', 'Medium', 'Large']);

/** UTC 自然月月初（含） */
export function monthStartOf(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** 下一 UTC 自然月月初（本月账期右端，不含） */
export function nextMonthStart(monthStart: number): number {
  const d = new Date(monthStart);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function kindCode(event: BillingEvent): number {
  return event.kind === 'start' ? KIND_START : event.kind === 'stop' ? KIND_STOP : KIND_PLAN;
}

/** 单实例单月的列式事件存储：按生效时刻升序，支持任意位置高效插入 */
class MonthEvents {
  at: Float64Array;
  kind: Uint8Array;
  plan: Uint8Array;
  len = 0;

  private constructor(capacity: number) {
    this.at = new Float64Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.plan = new Uint8Array(capacity);
  }

  static from(events: BillingEvent[]): MonthEvents {
    const store = new MonthEvents(Math.max(events.length, 16));
    for (const event of events) {
      store.at[store.len] = event.effectiveAt;
      store.kind[store.len] = kindCode(event);
      store.plan[store.len] = event.plan ? PLAN_INDEX[event.plan] : 0;
      store.len++;
    }
    return store;
  }

  /** 按生效时刻升序插入（同刻不同类事件顺序不影响结果，插在已有同刻事件之后） */
  insert(event: BillingEvent): void {
    if (this.len === this.at.length) this.grow();
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.at[mid] <= event.effectiveAt) lo = mid + 1;
      else hi = mid;
    }
    this.at.copyWithin(lo + 1, lo, this.len);
    this.kind.copyWithin(lo + 1, lo, this.len);
    this.plan.copyWithin(lo + 1, lo, this.len);
    this.at[lo] = event.effectiveAt;
    this.kind[lo] = kindCode(event);
    this.plan[lo] = event.plan ? PLAN_INDEX[event.plan] : 0;
    this.len++;
  }

  private grow(): void {
    const capacity = this.at.length * 2;
    const at = new Float64Array(capacity);
    const kind = new Uint8Array(capacity);
    const plan = new Uint8Array(capacity);
    at.set(this.at);
    kind.set(this.kind);
    plan.set(this.plan);
    this.at = at;
    this.kind = kind;
    this.plan = plan;
  }
}

/** 单实例单月的内存缓存：有序事件 + 已算账单（null 表示待重算） */
interface MonthData {
  events: MonthEvents;
  bill: MonthlyBill | null;
}

/**
 * 对外门面：补录记录 + 查看单实例月账单。
 * 记录持久化在 SQLite；账单按 (实例, 月) 缓存在内存中，
 * 补录历史记录仅失效受影响月份，重启后从记录重建，结果不变。
 */
export class BillingService {
  private store: EventStore;
  private db;
  /** instanceId -> (monthStart -> MonthData) */
  private months = new Map<string, Map<number, MonthData>>();

  /** path 为 SQLite 文件路径；传 ':memory:' 则仅内存 */
  constructor(path: string) {
    this.db = openDatabase(path);
    this.store = new EventStore(this.db);
  }

  /** 补录一条生命周期记录（可乱序、可重放；重放不影响结果） */
  record(event: BillingEvent): void {
    validateEvent(event);
    const inserted = this.store.insert(event);
    if (!inserted) return; // 重放：内容与已存一致，无影响
    this.applyToCache(event);
  }

  /** 批量补录（单事务写入，用于初始装载等大批量场景） */
  recordAll(events: BillingEvent[]): void {
    for (const event of events) validateEvent(event);
    const inserted: BillingEvent[] = [];
    this.db.exec('BEGIN');
    try {
      for (const event of events) {
        if (this.store.insert(event)) inserted.push(event);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // 批量场景下逐条维护内存有序结构代价过高，直接丢弃受影响月份缓存，
    // 下次查看时从 SQLite 惰性重建。
    const minMonthByInstance = new Map<string, number>();
    for (const event of inserted) {
      const m = monthStartOf(event.effectiveAt);
      const prev = minMonthByInstance.get(event.instanceId);
      if (prev === undefined || m < prev) minMonthByInstance.set(event.instanceId, m);
    }
    for (const [instanceId, minMonth] of minMonthByInstance) {
      const byMonth = this.months.get(instanceId);
      if (!byMonth) continue;
      for (const monthStart of [...byMonth.keys()]) {
        if (monthStart >= minMonth) byMonth.delete(monthStart);
      }
    }
  }

  /** 查看某实例某 UTC 自然月的账单。month 为该月内任意时刻（ms） */
  getMonthlyBill(instanceId: string, month: number): MonthlyBill {
    const monthStart = monthStartOf(month);
    const monthEnd = nextMonthStart(monthStart);
    const data = this.getOrLoadMonth(instanceId, monthStart, monthEnd);
    if (!data.bill) {
      const stateBefore = this.store.latestStateBefore(instanceId, monthStart);
      const planBefore = this.store.latestPlanBefore(instanceId, monthStart);
      const { events } = data;
      data.bill = computeMonthlyBillColumns(
        instanceId,
        monthStart,
        monthEnd,
        stateBefore?.kind === 'start',
        (planBefore?.plan ?? 'Small') as Plan,
        events.at,
        events.kind,
        events.plan,
        events.len,
      );
    }
    const bill = data.bill;
    // 返回拷贝，避免调用方修改污染缓存
    return {
      ...bill,
      lines: bill.lines.map((line) => ({ ...line })),
    };
  }

  /** 正常关闭（记录已持久化，重启后账单结果不变） */
  close(): void {
    this.db.close();
  }

  /** 将单条新记录并入内存缓存，并失效可能受影响的后续月份 */
  private applyToCache(event: BillingEvent): void {
    const byMonth = this.months.get(event.instanceId);
    if (!byMonth) return; // 该实例尚未加载任何月份，无需维护
    const eventMonth = monthStartOf(event.effectiveAt);
    for (const [monthStart, data] of byMonth) {
      if (monthStart > eventMonth) {
        // 后续月份的月初状态可能改变，仅作废账单，保留事件列表
        data.bill = null;
      } else if (monthStart === eventMonth) {
        data.events.insert(event);
        data.bill = null;
      }
    }
  }

  private getOrLoadMonth(instanceId: string, monthStart: number, monthEnd: number): MonthData {
    let byMonth = this.months.get(instanceId);
    if (!byMonth) {
      byMonth = new Map();
      this.months.set(instanceId, byMonth);
    }
    let data = byMonth.get(monthStart);
    if (!data) {
      data = {
        events: MonthEvents.from(this.store.eventsInRange(instanceId, monthStart, monthEnd)),
        bill: null,
      };
      byMonth.set(monthStart, data);
    }
    return data;
  }
}

function validateEvent(event: BillingEvent): void {
  if (!event.instanceId) throw new Error('instanceId is required');
  if (!event.eventId) throw new Error('eventId is required');
  if (!Number.isFinite(event.effectiveAt)) throw new Error('effectiveAt must be a finite number (ms)');
  if (event.kind !== 'start' && event.kind !== 'stop' && event.kind !== 'plan') {
    throw new Error(`invalid kind: ${event.kind}`);
  }
  if (event.kind === 'plan') {
    if (!event.plan || !VALID_PLANS.has(event.plan)) {
      throw new Error(`plan event requires a valid plan, got: ${event.plan}`);
    }
    if (!(event.plan in PLAN_MICRO_DOLLARS_PER_HOUR)) {
      throw new Error(`unknown plan: ${event.plan}`);
    }
  }
}
