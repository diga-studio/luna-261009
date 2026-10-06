import type { Policy } from '../src/types.js';
import { parseTimeOfDay } from '../src/timeWindow.js';

/** 参考实现自带的策略编译与决策，不依赖 src/policy.ts 的索引结构。 */
export interface RefCompiled {
  effect: 'allow' | 'deny';
  priority: number;
  maxSessionMs: number;
  requiresApproval: boolean;
  winStartMs: number;
  winEndMs: number;
  allDay: boolean;
}

export function compileForTest(p: Policy): RefCompiled {
  const s = parseTimeOfDay(p.window.start) * 60_000;
  const e = parseTimeOfDay(p.window.end) * 60_000;
  return {
    effect: p.effect,
    priority: p.priority,
    maxSessionMs: p.effect === 'allow' ? (p.maxSessionMs ?? 8 * 3_600_000) : 0,
    requiresApproval: p.effect === 'allow' ? (p.requiresApproval ?? false) : false,
    winStartMs: s,
    winEndMs: e,
    allDay: s === e,
  };
}

export function decideForTest(
  candidates: readonly RefCompiled[],
  timeMs: number,
): { allowed: boolean; maxSessionMs: number; requiresApproval: boolean } {
  const DAY = 86_400_000;
  const tod = ((timeMs % DAY) + DAY) % DAY;
  let bestP = Infinity;
  let bestS = Infinity;
  let approval = false;
  for (const c of candidates) {
    const inW = c.allDay
      ? true
      : c.winStartMs < c.winEndMs
        ? tod >= c.winStartMs && tod < c.winEndMs
        : tod >= c.winStartMs || tod < c.winEndMs;
    if (!inW) continue;
    if (c.effect === 'deny') return { allowed: false, maxSessionMs: 0, requiresApproval: false };
    if (c.priority < bestP) {
      bestP = c.priority;
      bestS = c.maxSessionMs;
      approval = c.requiresApproval;
    } else if (c.priority === bestP) {
      if (c.maxSessionMs < bestS) {
        bestS = c.maxSessionMs;
        approval = c.requiresApproval;
      } else if (c.maxSessionMs === bestS) {
        approval = approval || c.requiresApproval;
      }
    }
  }
  if (bestP === Infinity) return { allowed: false, maxSessionMs: 0, requiresApproval: false };
  return { allowed: true, maxSessionMs: bestS, requiresApproval: approval };
}
