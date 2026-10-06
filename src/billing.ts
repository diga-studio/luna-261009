import { BillingEvent, BillLine, MonthlyBill, Plan } from './types';

/** 每小时单价（微美元，避免浮点误差） */
export const PLAN_MICRO_DOLLARS_PER_HOUR: Record<Plan, bigint> = {
  Small: 15_000n,   // $0.015
  Medium: 45_000n,  // $0.045
  Large: 120_000n,  // $0.12
};

/** 事件种类的紧凑编码（列式存储用） */
export const KIND_START = 0;
export const KIND_STOP = 1;
export const KIND_PLAN = 2;

/** 套餐的紧凑编码 */
export const PLAN_ORDER: readonly Plan[] = ['Small', 'Medium', 'Large'];
export const PLAN_INDEX: Record<Plan, number> = { Small: 0, Medium: 1, Large: 2 };

const MS_PER_HOUR = 3_600_000n;
const MICRO_DOLLARS_PER_CENT = 10_000n;

/**
 * 毫秒用量按每小时单价（微美元）计费并四舍五入到美分，恰好半分向上取整。
 * 全程 BigInt 精确运算：fee_cents = ms * micro / (3600000 * 10000)。
 */
export function priceToCents(runningMs: number, microDollarsPerHour: bigint): bigint {
  const numerator = BigInt(runningMs) * microDollarsPerHour;
  const denominator = MS_PER_HOUR * MICRO_DOLLARS_PER_CENT;
  // floor(x + 1/2) = (2n + d) div (2d)，非负值即“半分向上”
  return (2n * numerator + denominator) / (2n * denominator);
}

/**
 * 由月初状态 + 月内事件（已按生效时刻升序）精确计算月账单。
 * 同一时刻的启停与套餐变更互不影响（分别作用于不同状态维度），
 * 因此同刻事件的应用顺序不影响结果。
 */
export function computeMonthlyBill(
  instanceId: string,
  monthStart: number,
  monthEnd: number,
  runningAtStart: boolean,
  planAtStart: Plan,
  monthEvents: BillingEvent[],
): MonthlyBill {
  const usageMs: Record<Plan, number> = { Small: 0, Medium: 0, Large: 0 };
  let running = runningAtStart;
  let plan: Plan = planAtStart;
  let segmentStart = monthStart;

  for (const event of monthEvents) {
    const at = event.effectiveAt;
    if (at < monthStart) continue; // 防御：月初之前的事件只应影响月初状态
    if (at >= monthEnd) break; // 防御：月末及之后的事件不属于本月（事件已升序）
    if (running && at > segmentStart) {
      usageMs[plan] += at - segmentStart;
    }
    segmentStart = at;
    if (event.kind === 'start') {
      running = true;
    } else if (event.kind === 'stop') {
      running = false;
    } else if (event.kind === 'plan' && event.plan) {
      plan = event.plan;
    }
  }
  if (running && monthEnd > segmentStart) {
    usageMs[plan] += monthEnd - segmentStart;
  }

  const lines: BillLine[] = [];
  let totalCents = 0n;
  for (const p of ['Small', 'Medium', 'Large'] as Plan[]) {
    const runningMs = usageMs[p];
    if (runningMs === 0) continue;
    const amountCents = priceToCents(runningMs, PLAN_MICRO_DOLLARS_PER_HOUR[p]);
    lines.push({ plan: p, runningMs, amountCents });
    totalCents += amountCents;
  }

  return { instanceId, monthStart, monthEnd, lines, totalCents };
}

/**
 * 列式存储的扫描版本：与 computeMonthlyBill 语义完全一致，
 * 但作用于类型化数组，避免大数组上对象属性访问的开销。
 */
export function computeMonthlyBillColumns(
  instanceId: string,
  monthStart: number,
  monthEnd: number,
  runningAtStart: boolean,
  planAtStart: Plan,
  at: Float64Array,
  kind: Uint8Array,
  plan: Uint8Array,
  len: number,
): MonthlyBill {
  const usageMs: Record<Plan, number> = { Small: 0, Medium: 0, Large: 0 };
  let running = runningAtStart;
  let planIdx = PLAN_INDEX[planAtStart];
  let segmentStart = monthStart;

  for (let i = 0; i < len; i++) {
    const t = at[i];
    if (running && t > segmentStart) {
      usageMs[PLAN_ORDER[planIdx]] += t - segmentStart;
    }
    segmentStart = t;
    const k = kind[i];
    if (k === KIND_START) {
      running = true;
    } else if (k === KIND_STOP) {
      running = false;
    } else {
      planIdx = plan[i];
    }
  }
  if (running && monthEnd > segmentStart) {
    usageMs[PLAN_ORDER[planIdx]] += monthEnd - segmentStart;
  }

  const lines: BillLine[] = [];
  let totalCents = 0n;
  for (const p of PLAN_ORDER) {
    const runningMs = usageMs[p];
    if (runningMs === 0) continue;
    const amountCents = priceToCents(runningMs, PLAN_MICRO_DOLLARS_PER_HOUR[p]);
    lines.push({ plan: p, runningMs, amountCents });
    totalCents += amountCents;
  }

  return { instanceId, monthStart, monthEnd, lines, totalCents };
}
