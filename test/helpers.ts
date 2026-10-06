import { priceToCents, PLAN_MICRO_DOLLARS_PER_HOUR } from '../src/billing';
import { BillingEvent, MonthlyBill, Plan } from '../src/types';
import { monthStartOf, nextMonthStart } from '../src/service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export { monthStartOf, nextMonthStart, priceToCents, PLAN_MICRO_DOLLARS_PER_HOUR };

/**
 * 独立参考实现：从完整时间轴暴力扫描计算月账单。
 * 与被测库的按月缓存/增量路径完全无关，用于交叉验证。
 */
export function referenceBill(
  instanceId: string,
  allEvents: BillingEvent[],
  monthStart: number,
): MonthlyBill {
  const monthEnd = nextMonthStart(monthStart);
  const sorted = allEvents.filter((e) => e.instanceId === instanceId).sort((a, b) => a.effectiveAt - b.effectiveAt);
  const usageMs: Record<Plan, number> = { Small: 0, Medium: 0, Large: 0 };
  let running = false;
  let plan: Plan = 'Small';

  let i = 0;
  // 月初之前的事件只决定月初状态
  while (i < sorted.length && sorted[i].effectiveAt < monthStart) {
    apply(sorted[i]);
    i++;
  }
  let cursor = monthStart;
  while (i < sorted.length && sorted[i].effectiveAt < monthEnd) {
    const at = sorted[i].effectiveAt;
    if (running && at > cursor) usageMs[plan] += at - cursor;
    cursor = at;
    apply(sorted[i]);
    i++;
  }
  if (running && monthEnd > cursor) usageMs[plan] += monthEnd - cursor;

  const lines = (['Small', 'Medium', 'Large'] as Plan[])
    .filter((p) => usageMs[p] > 0)
    .map((p) => ({ plan: p, runningMs: usageMs[p], amountCents: priceToCents(usageMs[p], PLAN_MICRO_DOLLARS_PER_HOUR[p]) }));
  const totalCents = lines.reduce((sum, l) => sum + l.amountCents, 0n);
  return { instanceId, monthStart, monthEnd, lines, totalCents };

  function apply(e: BillingEvent): void {
    if (e.kind === 'start') running = true;
    else if (e.kind === 'stop') running = false;
    else if (e.kind === 'plan' && e.plan) plan = e.plan;
  }
}

/** 可复现的伪随机数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 洗牌（返回新数组） */
export function shuffled<T>(items: T[], rand: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 创建临时 SQLite 文件路径 */
export function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));
  return path.join(dir, name);
}

/** 构造事件 */
export function ev(
  eventId: string,
  instanceId: string,
  effectiveAt: number,
  kind: BillingEvent['kind'],
  plan?: Plan,
): BillingEvent {
  return { eventId, instanceId, effectiveAt, kind, ...(plan ? { plan } : {}) };
}

/** 断言两个账单完全一致 */
export function billsEqual(a: MonthlyBill, b: MonthlyBill): boolean {
  if (a.instanceId !== b.instanceId || a.monthStart !== b.monthStart || a.monthEnd !== b.monthEnd) return false;
  if (a.totalCents !== b.totalCents || a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, i) => {
    const other = b.lines[i];
    return line.plan === other.plan && line.runningMs === other.runningMs && line.amountCents === other.amountCents;
  });
}
