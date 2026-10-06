import type { LifecycleRecord, Plan } from "./types.js";

const PLAN_CODE: Record<Plan, number> = { small: 0, medium: 1, large: 2 };

/** 首个 >= t 的下标。 */
function lowerBound(arr: Float64Array, len: number, t: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 定长类型化数组序列，按 t 升序，支持任意位置插入。 */
class Timeline {
  times = new Float64Array(1024);
  values: Uint8Array;
  length = 0;

  constructor() {
    this.values = new Uint8Array(1024);
  }

  /** 插入 (t, value)；相同 t 时插到已有元素之后。 */
  insert(t: number, value: number): void {
    let pos = lowerBound(this.times, this.length, t);
    while (pos < this.length && this.times[pos] === t) pos++;
    if (this.length === this.times.length) {
      const cap = this.times.length * 2;
      const newTimes = new Float64Array(cap);
      const newValues = new Uint8Array(cap);
      newTimes.set(this.times);
      newValues.set(this.values);
      this.times = newTimes;
      this.values = newValues;
    }
    if (pos < this.length) {
      this.times.copyWithin(pos + 1, pos, this.length);
      this.values.copyWithin(pos + 1, pos, this.length);
    }
    this.times[pos] = t;
    this.values[pos] = value;
    this.length++;
  }

  /** 首个 >= t 的下标。 */
  indexOf(t: number): number {
    return lowerBound(this.times, this.length, t);
  }
}

/**
 * 单实例的内存索引：按时间排序的启停/套餐序列，
 * 支持乱序补录与快速月度用量计算。
 */
export class InstanceIndex {
  private readonly power = new Timeline();
  private readonly plans = new Timeline();

  constructor(records: LifecycleRecord[]) {
    for (const record of records) this.add(record);
  }

  /** 追加一条新记录（调用方保证 eventId 未出现过）。 */
  add(record: LifecycleRecord): void {
    if (record.kind === "plan") {
      this.plans.insert(record.effectiveAt, PLAN_CODE[record.plan!]);
    } else {
      this.power.insert(record.effectiveAt, record.kind === "start" ? 1 : 0);
    }
  }

  /**
   * 计算 [monthStart, monthEnd) 内各套餐的运行毫秒数。
   * 返回键为全部三种套餐。
   */
  usageInRange(monthStart: number, monthEnd: number): Record<Plan, number> {
    const usage: Record<Plan, number> = { small: 0, medium: 0, large: 0 };
    const powerT = this.power.times;
    const powerV = this.power.values;
    const powerLen = this.power.length;
    const planT = this.plans.times;
    const planV = this.plans.values;
    const planLen = this.plans.length;
    let powerIdx = lowerBound(powerT, powerLen, monthStart);
    let planIdx = lowerBound(planT, planLen, monthStart);
    // 月初状态由此前的记录决定；默认停止 + Small。
    let running = powerIdx > 0 ? powerV[powerIdx - 1] === 1 : false;
    let planCode = planIdx > 0 ? planV[planIdx - 1]! : 0;
    const usageByCode = [0, 0, 0];

    let cursor = monthStart;
    for (;;) {
      const nextPowerT = powerIdx < powerLen ? powerT[powerIdx]! : Infinity;
      const nextPlanT = planIdx < planLen ? planT[planIdx]! : Infinity;
      const nextT = Math.min(nextPowerT, nextPlanT);
      if (nextT >= monthEnd) break;
      if (running) usageByCode[planCode]! += nextT - cursor;
      // 同一时刻的启停与套餐变更同时生效。
      while (powerIdx < powerLen && powerT[powerIdx] === nextT) {
        running = powerV[powerIdx] === 1;
        powerIdx++;
      }
      while (planIdx < planLen && planT[planIdx] === nextT) {
        planCode = planV[planIdx]!;
        planIdx++;
      }
      cursor = nextT;
    }
    if (running) usageByCode[planCode]! += monthEnd - cursor;
    usage.small = usageByCode[0]!;
    usage.medium = usageByCode[1]!;
    usage.large = usageByCode[2]!;
    return usage;
  }
}
