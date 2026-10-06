import { parseTimeOfDay, windowContainsParsed } from './timeWindow.js';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
export function compilePolicy(policy) {
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
export function principalMatches(principal, identity) {
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
export function decideCompiled(compiled, identity, environmentId, resourceType, utcMs) {
    let bestPriority = Infinity;
    let bestSession = Infinity;
    let bestRequiresApproval = false;
    let hasAllow = false;
    for (const policy of compiled) {
        if (policy.environmentId !== environmentId)
            continue;
        if (policy.resourceType !== resourceType)
            continue;
        if (!principalMatches(policy.principal, identity))
            continue;
        if (!windowContainsParsed(policy.windowStartMs, policy.windowEndMs, utcMs))
            continue;
        if (policy.effect === 'deny') {
            return { allowed: false, maxSessionMs: null, requiresApproval: false };
        }
        if (policy.priority < bestPriority) {
            bestPriority = policy.priority;
            bestSession = policy.maxSessionMs;
            bestRequiresApproval = policy.requiresApproval;
            hasAllow = true;
        }
        else if (policy.priority === bestPriority) {
            if (policy.maxSessionMs < bestSession)
                bestSession = policy.maxSessionMs;
            if (policy.requiresApproval)
                bestRequiresApproval = true;
        }
    }
    if (!hasAllow)
        return { allowed: false, maxSessionMs: null, requiresApproval: false };
    return { allowed: true, maxSessionMs: bestSession, requiresApproval: bestRequiresApproval };
}
/** 单时刻判定（每次调用重新解析窗口，非热路径使用） */
export function decideAt(policies, identity, environmentId, resourceType, utcMs) {
    return decideCompiled(policies.map(compilePolicy), identity, environmentId, resourceType, utcMs);
}
