import type { DriftInterval, Grant, Snapshot } from './types.js';
import { buildPolicyIndex } from './policy.js';
import { driftIntervalsForGroup } from './grants.js';

/** 分析范围：审计时刻至其后 8 小时。 */
export const ANALYSIS_HORIZON_MS = 8 * 60 * 60 * 1000;

const EMPTY: readonly string[] = [];

/**
 * 对不可变快照做全量权限漂移分析。
 * 返回 [auditTimeMs, auditTimeMs+8h) 内全部最大漂移区间（左闭右开）。
 */
export function analyzeDrift(snapshot: Snapshot): DriftInterval[] {
  const fromMs = snapshot.auditTimeMs;
  const toMs = fromMs + ANALYSIS_HORIZON_MS;

  const rolesByUser = new Map<string, readonly string[]>();
  const groupsByUser = new Map<string, readonly string[]>();
  for (const identity of snapshot.identities) {
    rolesByUser.set(identity.id, identity.roleIds);
    groupsByUser.set(identity.id, identity.groupIds);
  }

  const index = buildPolicyIndex(snapshot.policies);

  // 按 (用户, 环境, 资源类型) 分组授权。
  const groups = new Map<string, Grant[]>();
  for (const grant of snapshot.grants) {
    if (grant.endMs <= fromMs || grant.startMs >= toMs) continue;
    const key = `${grant.userId}${grant.environmentId}${grant.resourceType}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(grant);
  }

  const results: DriftInterval[] = [];
  for (const grants of groups.values()) {
    const { userId, environmentId, resourceType } = grants[0];
    const roleIds = rolesByUser.get(userId) ?? EMPTY;
    const groupIds = groupsByUser.get(userId) ?? EMPTY;
    const candidates = index.candidatesFor(
      userId,
      roleIds,
      groupIds,
      environmentId,
      resourceType,
    );
    const intervals = driftIntervalsForGroup(candidates, grants, fromMs, toMs);
    for (const interval of intervals) {
      results.push({ userId, environmentId, resourceType, ...interval });
    }
  }

  results.sort(
    (a, b) =>
      a.userId.localeCompare(b.userId) ||
      a.environmentId.localeCompare(b.environmentId) ||
      a.resourceType.localeCompare(b.resourceType) ||
      a.startMs - b.startMs ||
      a.endMs - b.endMs,
  );
  return results;
}
