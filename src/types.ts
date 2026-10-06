/** 套餐类型。 */
export type Plan = "small" | "medium" | "large";

/** 生命周期记录类型：启停或套餐变更，一条记录只描述一种。 */
export type RecordKind = "start" | "stop" | "plan";

/** 生命周期记录。effectiveAt 为 UTC 毫秒时间戳。 */
export interface LifecycleRecord {
  /** 全局唯一事件标识；重放（相同标识、相同内容）不影响结果。 */
  eventId: string;
  /** 实例标识。 */
  instanceId: string;
  /** 生效时刻，UTC 毫秒。 */
  effectiveAt: number;
  kind: RecordKind;
  /** 仅 kind === "plan" 时存在。 */
  plan?: Plan;
}

/** 单个套餐的月度列项。 */
export interface PlanLineItem {
  plan: Plan;
  /** 本月该套餐下的运行毫秒数。 */
  runningMs: number;
  /** 费用，单位美分，已按规则四舍五入（半分向上）。 */
  costCents: number;
}

/** 单实例月账单。 */
export interface MonthlyBill {
  instanceId: string;
  /** 账单月起始（UTC 毫秒，含）。 */
  monthStart: number;
  /** 账单月结束（UTC 毫秒，不含）。 */
  monthEnd: number;
  lineItems: PlanLineItem[];
  /** 总额（美分），等于各列项已舍入费用之和。 */
  totalCents: number;
}

export const PLANS: readonly Plan[] = ["small", "medium", "large"];

/** 每小时价格，单位为 1e-5 美元（保证整数精确运算）。 */
export const PLAN_RATE_MICROUSD_PER_HOUR: Readonly<Record<Plan, number>> = {
  small: 1500, // $0.015
  medium: 4500, // $0.045
  large: 12000, // $0.12
};
