/** 套餐类型 */
export type Plan = 'Small' | 'Medium' | 'Large';

/** 生命周期记录种类：启停 或 套餐变更，一条记录只描述一种 */
export type EventKind = 'start' | 'stop' | 'plan';

/** 上层补录的生命周期记录 */
export interface BillingEvent {
  /** 实例标识 */
  instanceId: string;
  /** 全局唯一事件标识（重放幂等） */
  eventId: string;
  /** 精确到毫秒的 UTC 生效时刻（Unix epoch ms） */
  effectiveAt: number;
  kind: EventKind;
  /** 仅 kind === 'plan' 时携带 */
  plan?: Plan;
}

/** 账单中按套餐列项 */
export interface BillLine {
  plan: Plan;
  /** 本月该套餐下的运行毫秒数 */
  runningMs: number;
  /** 该套餐费用（美元，已按规则舍入到美分） */
  amountCents: bigint;
}

/** 单实例月账单 */
export interface MonthlyBill {
  instanceId: string;
  /** 账期月初（UTC，Unix epoch ms，含） */
  monthStart: number;
  /** 账期月末（UTC，Unix epoch ms，不含） */
  monthEnd: number;
  lines: BillLine[];
  /** 总额 = 各项已舍入费用之和（美分） */
  totalCents: bigint;
}
