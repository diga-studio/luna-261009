import type { DriftInterval, Grant, Identity, Snapshot } from './types.js';
import {
  compilePolicy,
  decideCompiled,
  principalMatches,
  type CompiledPolicy,
} from './policy.js';
import { mergeIntervals, subtractIntervals, type Interval } from './intervals.js';

const MS_PER_DAY = 86_400_000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

interface GrantGroup {
  userId: string;
  environmentId: string;
  resourceType: string;
  grants: Grant[];
}

/** 窗口边界（当日毫秒）在 [rangeStart, rangeEnd) 内的出现时刻，无则 null */
function edgeOccurrence(
  msOfDay: number,
  rangeStart: number,
  rangeEnd: number,
): number | null {
  const dayStart = Math.floor(rangeStart / MS_PER_DAY) * MS_PER_DAY;
  let t = dayStart + msOfDay;
  if (t < rangeStart) t += MS_PER_DAY;
  return t > rangeStart && t < rangeEnd ? t : null;
}

function analyzeGroup(
  group: GrantGroup,
  identity: Identity,
  policiesByKey: Map<string, CompiledPolicy[]>,
  rangeStart: number,
  rangeEnd: number,
): DriftInterval[] {
  const key = `${group.environmentId}${group.resourceType}`;
  const candidates = policiesByKey.get(key) ?? [];
  const matched = candidates.filter((p) =>
    principalMatches(p.principal, identity),
  );

  // 实际访问区间：授权起止裁剪到分析范围
  const actual: Interval[] = [];
  for (const g of group.grants) {
    const start = Math.max(g.startMs, rangeStart);
    const end = Math.min(g.endMs, rangeEnd);
    if (end > start) actual.push({ start, end });
  }
  if (actual.length === 0) return [];
  const actualUnion = mergeIntervals(actual);

  // 没有任何 allow 策略时，任何时刻都不合规，全部实际访问都是漂移
  if (!matched.some((p) => p.effect === 'allow')) {
    return actualUnion.map((iv) => ({
      userId: group.userId,
      environmentId: group.environmentId,
      resourceType: group.resourceType,
      startMs: iv.start,
      endMs: iv.end,
    }));
  }

  // 变化点：范围端点、授权边界、策略窗口边界
  const points = new Set<number>([rangeStart, rangeEnd]);
  for (const iv of actualUnion) {
    points.add(iv.start);
    points.add(iv.end);
  }
  for (const p of matched) {
    if (p.windowStartMs === p.windowEndMs) continue; // 全天，无边界
    const s = edgeOccurrence(p.windowStartMs, rangeStart, rangeEnd);
    if (s !== null) points.add(s);
    const e = edgeOccurrence(p.windowEndMs, rangeStart, rangeEnd);
    if (e !== null) points.add(e);
  }
  const sortedPoints = Array.from(points).sort((a, b) => a - b);

  // 逐段求合规覆盖区间
  const compliant: Interval[] = [];
  for (let i = 0; i + 1 < sortedPoints.length; i++) {
    const segStart = sortedPoints[i]!;
    const segEnd = sortedPoints[i + 1]!;
    const decision = decideCompiled(
      matched,
      identity,
      group.environmentId,
      group.resourceType,
      segStart,
    );
    if (!decision.allowed) continue;
    const session = decision.maxSessionMs!;
    for (const g of group.grants) {
      if (decision.requiresApproval && !g.approved) continue;
      const start = Math.max(g.startMs, segStart);
      const end = Math.min(g.endMs, g.startMs + session, segEnd);
      if (end > start) compliant.push({ start, end });
    }
  }

  const drift = subtractIntervals(actualUnion, mergeIntervals(compliant));
  return drift.map((iv) => ({
    userId: group.userId,
    environmentId: group.environmentId,
    resourceType: group.resourceType,
    startMs: iv.start,
    endMs: iv.end,
  }));
}

/**
 * 全量分析：返回 [auditMs, auditMs+8h) 内所有过度授权的最大合并区间。
 * 仅当实际访问存在且没有任何合规授权覆盖时报告漂移；
 * 同一 (用户, 环境, 资源类型) 上的漂移区间合并重叠及首尾相接部分。
 */
export function analyzeDrift(snapshot: Snapshot): DriftInterval[] {
  const rangeStart = snapshot.auditMs;
  const rangeEnd = rangeStart + EIGHT_HOURS_MS;

  const identities = new Map<string, Identity>();
  for (const id of snapshot.identities) identities.set(id.userId, id);

  const policiesByKey = new Map<string, CompiledPolicy[]>();
  for (const policy of snapshot.policies) {
    const key = `${policy.environmentId}${policy.resourceType}`;
    const list = policiesByKey.get(key);
    const compiled = compilePolicy(policy);
    if (list) list.push(compiled);
    else policiesByKey.set(key, [compiled]);
  }

  const groups = new Map<string, GrantGroup>();
  for (const grant of snapshot.grants) {
    const key = `${grant.userId}${grant.environmentId}${grant.resourceType}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        userId: grant.userId,
        environmentId: grant.environmentId,
        resourceType: grant.resourceType,
        grants: [],
      };
      groups.set(key, group);
    }
    group.grants.push(grant);
  }

  const results: DriftInterval[] = [];
  for (const group of groups.values()) {
    const identity = identities.get(group.userId) ?? {
      userId: group.userId,
      roles: [],
      groups: [],
    };
    results.push(
      ...analyzeGroup(group, identity, policiesByKey, rangeStart, rangeEnd),
    );
  }

  results.sort(
    (a, b) =>
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0) ||
      (a.environmentId < b.environmentId
        ? -1
        : a.environmentId > b.environmentId
          ? 1
          : 0) ||
      (a.resourceType < b.resourceType
        ? -1
        : a.resourceType > b.resourceType
          ? 1
          : 0) ||
      a.startMs - b.startMs,
  );
  return results;
}
