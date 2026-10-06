import type { Policy } from './types.js';
import { parseTimeOfDay } from './timeWindow.js';

export const DEFAULT_MAX_SESSION_MS = 8 * 60 * 60 * 1000;

/** 预解析窗口后的策略，避免重复解析字符串。 */
export interface CompiledPolicy {
  effect: 'allow' | 'deny';
  priority: number;
  maxSessionMs: number;
  requiresApproval: boolean;
  /** 窗口起点（一天内毫秒），0..86399999 */
  winStartMs: number;
  winEndMs: number;
  allDay: boolean;
}

export type PolicyDecision =
  | { allowed: false }
  | { allowed: true; maxSessionMs: number; requiresApproval: boolean };

const DENIED: PolicyDecision = { allowed: false };

function compile(policy: Policy): CompiledPolicy {
  const startMin = parseTimeOfDay(policy.window.start);
  const endMin = parseTimeOfDay(policy.window.end);
  return {
    effect: policy.effect,
    priority: policy.priority,
    maxSessionMs:
      policy.effect === 'allow'
        ? (policy.maxSessionMs ?? DEFAULT_MAX_SESSION_MS)
        : 0,
    requiresApproval:
      policy.effect === 'allow' ? (policy.requiresApproval ?? false) : false,
    winStartMs: startMin * 60_000,
    winEndMs: endMin * 60_000,
    allDay: startMin === endMin,
  };
}

function inWindow(p: CompiledPolicy, todMs: number): boolean {
  if (p.allDay) return true;
  if (p.winStartMs < p.winEndMs) {
    return todMs >= p.winStartMs && todMs < p.winEndMs;
  }
  return todMs >= p.winStartMs || todMs < p.winEndMs;
}

const MS_PER_DAY = 86_400_000;

/** 对一组候选策略在指定 UTC 时刻求解决策。 */
export function decide(
  candidates: readonly CompiledPolicy[],
  timeMs: number,
): PolicyDecision {
  const tod = ((timeMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  let bestPriority = Infinity;
  let bestSession = Infinity;
  let anyApproval = false;
  for (const p of candidates) {
    if (!inWindow(p, tod)) continue;
    if (p.effect === 'deny') return DENIED;
    if (p.priority < bestPriority) {
      bestPriority = p.priority;
      bestSession = p.maxSessionMs;
      anyApproval = p.requiresApproval;
    } else if (p.priority === bestPriority) {
      if (p.maxSessionMs < bestSession) {
        bestSession = p.maxSessionMs;
        anyApproval = p.requiresApproval;
      } else if (p.maxSessionMs === bestSession) {
        anyApproval = anyApproval || p.requiresApproval;
      }
    }
  }
  if (bestPriority === Infinity) return DENIED;
  return { allowed: true, maxSessionMs: bestSession, requiresApproval: anyApproval };
}

/**
 * 策略索引：按 主体(种类:id) + 环境 + 资源类型 分桶。
 */
export interface PolicyIndex {
  candidatesFor(
    userId: string,
    roleIds: readonly string[],
    groupIds: readonly string[],
    environmentId: string,
    resourceType: string,
  ): readonly CompiledPolicy[];
  decisionAt(
    userId: string,
    roleIds: readonly string[],
    groupIds: readonly string[],
    environmentId: string,
    resourceType: string,
    timeMs: number,
  ): PolicyDecision;
}

function bucketKey(kind: string, id: string, env: string, rt: string): string {
  return `${kind}${id}${env}${rt}`;
}

export function buildPolicyIndex(policies: readonly Policy[]): PolicyIndex {
  const buckets = new Map<string, CompiledPolicy[]>();
  for (const policy of policies) {
    const key = bucketKey(
      policy.principalKind,
      policy.principalId,
      policy.environmentId,
      policy.resourceType,
    );
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(compile(policy));
  }

  function candidatesFor(
    userId: string,
    roleIds: readonly string[],
    groupIds: readonly string[],
    environmentId: string,
    resourceType: string,
  ): readonly CompiledPolicy[] {
    const out: CompiledPolicy[] = [];
    const userBucket = buckets.get(bucketKey('user', userId, environmentId, resourceType));
    if (userBucket) out.push(...userBucket);
    for (const roleId of roleIds) {
      const b = buckets.get(bucketKey('role', roleId, environmentId, resourceType));
      if (b) out.push(...b);
    }
    for (const groupId of groupIds) {
      const b = buckets.get(bucketKey('group', groupId, environmentId, resourceType));
      if (b) out.push(...b);
    }
    return out;
  }

  return {
    candidatesFor,
    decisionAt(userId, roleIds, groupIds, environmentId, resourceType, timeMs) {
      return decide(
        candidatesFor(userId, roleIds, groupIds, environmentId, resourceType),
        timeMs,
      );
    },
  };
}
