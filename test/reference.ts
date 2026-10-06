import type { LifecycleRecord, MonthlyBill, Plan } from "../src/index.js";
import { PLANS, costCentsFor } from "../src/index.js";

/**
 * 独立的参考实现：把完整时间轴排序后朴素扫描，
 * 不依赖被测库的任何索引/缓存逻辑，用于对照验证。
 */
export function referenceBill(
  records: LifecycleRecord[],
  instanceId: string,
  year: number,
  month: number,
): MonthlyBill {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);

  // 按 eventId 去重（重放不影响结果）。
  const seen = new Set<string>();
  const events: LifecycleRecord[] = [];
  for (const rec of records) {
    if (rec.instanceId !== instanceId || seen.has(rec.eventId)) continue;
    seen.add(rec.eventId);
    events.push(rec);
  }
  events.sort((a, b) => a.effectiveAt - b.effectiveAt);

  const usage: Record<Plan, number> = { small: 0, medium: 0, large: 0 };
  let running = false;
  let plan: Plan = "small";
  let cursor = monthStart;
  for (const event of events) {
    if (event.effectiveAt < monthStart) {
      if (event.kind === "plan") plan = event.plan!;
      else running = event.kind === "start";
      continue;
    }
    if (event.effectiveAt >= monthEnd) break;
    if (running) usage[plan] += event.effectiveAt - cursor;
    if (event.kind === "plan") plan = event.plan!;
    else running = event.kind === "start";
    cursor = event.effectiveAt;
  }
  if (running) usage[plan] += monthEnd - cursor;

  const lineItems = PLANS.map((p) => ({
    plan: p,
    runningMs: usage[p],
    costCents: costCentsFor(p, usage[p]),
  }));
  return {
    instanceId,
    monthStart,
    monthEnd,
    lineItems,
    totalCents: lineItems.reduce((sum, item) => sum + item.costCents, 0),
  };
}
