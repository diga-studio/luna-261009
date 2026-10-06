import type { Identity, Policy, Principal } from './types.js';
import { parseTimeOfDay, windowContainsParsed } from './timeWindow.js';

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/** 某时刻某身份在某环境/资源类型上的策略判定结果 */
export interface PolicyDecision {
  /** 是否允许访问（无匹配 allow 或存在生效 deny 时为 false） */
  allowed: boolean;
  /** 选定的最长会话时长（毫秒）；不允许时为 null */
  maxSessionMs: number | null;
  /** 选定的同级 allow 中是否有任意一条要求审批 */
  requiresApproval: boolean;
}

/** 窗口已解析为当日毫秒的策略，供热路径复用 */
export interface CompiledPolicy {
  principal: Principal;
  environmentId: string;
  resourceType: string;
  effect: 'allow' | 'deny';
  priority: number;
  windowStartMs: number;
  windowEndMs: number;
  maxSessionMs: number;
  requiresApproval: boolean;
}

export function compilePolicy(policy: Policy): CompiledPolicy {
  return {
    principal: policy.principal,
    environmentId: policy.environmentId,
    resourceType: policy.resourceType,
    effect: policy.effect,
    priority: policy.priority,
    windowStartMs: parseTimeOfDay(policy.window.start),
    windowEndMs: parseTimeOfDay(policy.window.end),
    maxSessionMs: policy.maxSessionMs ?? EIGHT_HOURS_MS,
    requiresApproval: policy.requiresApproval ?? false,
  };
}

export function principalMatches(principal: Principal, identity: Identity): boolean {
  switch (principal.kind) {
    case 'user':
      return principal.id === identity.userId;
    case 'role':
      return identity.roles.includes(principal.id);
    case 'group':
      return identity.groups.includes(principal.id);
  }
}

/**
 * 基于预编译策略计算某 UTC 毫秒时刻的判定。
 * 存在匹配且生效的 deny 即禁止（与优先级无关）；否则取生效 allow 的最小 priority，
 * 同级取最短 maxSessionMs，requiresApproval 为同级任意一条的逻辑或。
 */
export function decideCompiled(
  compiled: readonly CompiledPolicy[],
  identity: Identity,
  environmentId: string,
  resourceType: string,
  utcMs: number,
): PolicyDecision {
  let bestPriority = Infinity;
  let bestSession = Infinity;
  let bestRequiresApproval = false;
  let hasAllow = false;

  for (const policy of compiled) {
    if (policy.environmentId !== environmentId) continue;
    if (policy.resourceType !== resourceType) continue;
    if (!principalMatches(policy.principal, identity)) continue;
    if (!windowContainsParsed(policy.windowStartMs, policy.windowEndMs, utcMs)) continue;

    if (policy.effect === 'deny') {
      return { allowed: false, maxSessionMs: null, requiresApproval: false };
    }

    if (policy.priority < bestPriority) {
      bestPriority = policy.priority;
      bestSession = policy.maxSessionMs;
      bestRequiresApproval = policy.requiresApproval;
      hasAllow = true;
    } else if (policy.priority === bestPriority) {
      if (policy.maxSessionMs < bestSession) bestSession = policy.maxSessionMs;
      if (policy.requiresApproval) bestRequiresApproval = true;
    }
  }

  if (!hasAllow) return { allowed: false, maxSessionMs: null, requiresApproval: false };
  return { allowed: true, maxSessionMs: bestSession, requiresApproval: bestRequiresApproval };
}

/** 单时刻判定（每次调用重新解析窗口，非热路径使用） */
export function decideAt(
  policies: readonly Policy[],
  identity: Identity,
  environmentId: string,
  resourceType: string,
  utcMs: number,
): PolicyDecision {
  return decideCompiled(
    policies.map(compilePolicy),
    identity,
    environmentId,
    resourceType,
    utcMs,
  );
}
