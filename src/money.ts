import type { Plan } from "./types.js";
import { PLAN_RATE_MICROUSD_PER_HOUR } from "./types.js";

const MS_PER_HOUR = 3_600_000n;
/** 1 美分 = 1000 个 1e-5 美元单位。 */
const MICROUSD_PER_CENT = 1000n;

/**
 * 按套餐小时价计算运行毫秒数的费用，四舍五入到美分，恰好半分时向上取整。
 * 使用整数/BigInt 精确运算，避免浮点误差。
 */
export function costCentsFor(plan: Plan, runningMs: number): number {
  if (runningMs <= 0) return 0;
  // 精确费用（1e-5 美元）= runningMs * rate / MS_PER_HOUR
  const num = BigInt(runningMs) * BigInt(PLAN_RATE_MICROUSD_PER_HOUR[plan]);
  // 换算为美分并半分向上取整：floor((num/den + 0.5) / 1000)
  const cents =
    (2n * num + MS_PER_HOUR * MICROUSD_PER_CENT) /
    (2n * MS_PER_HOUR * MICROUSD_PER_CENT);
  return Number(cents);
}
