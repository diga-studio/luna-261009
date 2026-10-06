import type { Grant, Interval, Policy, Snapshot } from '../src/types.js';
import { compileForTest, decideForTest } from './referenceUtil.js';

const MS_PER_DAY = 86_400_000;

/**
 * 独立参考计算：暴力枚举所有关键时刻形成的基本区间，
 * 每个区间直接按定义求值，与主实现的扫描线算法完全无关。
 */
export function referenceDrift(
  snapshot: Snapshot,
  userId: string,
  environmentId: string,
  resourceType: string,
): Interval[] {
  const fromMs = snapshot.auditTimeMs;
  const toMs = fromMs + 8 * 3_600_000;
  const identity = snapshot.identities.find((i) => i.id === userId);
  const roleIds = identity?.roleIds ?? [];
  const groupIds = identity?.groupIds ?? [];
  const principals = new Set<string>([
    `user${userId}`,
    ...roleIds.map((r) => `role${r}`),
    ...groupIds.map((g) => `group${g}`),
  ]);
  const policies = snapshot.policies.filter(
    (p) =>
      p.environmentId === environmentId &&
      p.resourceType === resourceType &&
      principals.has(`${p.principalKind}${p.principalId}`),
  );
  const grants = snapshot.grants.filter(
    (g) =>
      g.userId === userId &&
      g.environmentId === environmentId &&
      g.resourceType === resourceType &&
      g.endMs > fromMs &&
      g.startMs < toMs,
  );
  if (grants.length === 0) return [];

  const compiled = policies.map(compileForTest);

  // 收集关键时刻。
  const points = new Set<number>([fromMs, toMs]);
  for (const g of grants) {
    points.add(Math.max(g.startMs, fromMs));
    points.add(Math.min(g.endMs, toMs));
    for (const c of compiled) {
      if (c.effect === 'allow') {
        const cap = g.startMs + c.maxSessionMs;
        if (cap > fromMs && cap < toMs) points.add(cap);
      }
    }
  }
  const firstDay = Math.floor(fromMs / MS_PER_DAY) - 1;
  const lastDay = Math.floor((toMs - 1) / MS_PER_DAY) + 1;
  for (const c of compiled) {
    if (c.allDay) continue;
    for (let day = firstDay; day <= lastDay; day++) {
      for (const edge of [day * MS_PER_DAY + c.winStartMs, day * MS_PER_DAY + c.winEndMs]) {
        if (edge > fromMs && edge < toMs) points.add(edge);
      }
    }
  }
  const sorted = [...points].sort((a, b) => a - b);

  const result: Interval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (s >= e) continue;
    const t = s; // 基本区间内状态不变，评估起点即可
    const access = grants.some((g) => g.startMs <= t && t < g.endMs);
    if (!access) continue;
    const decision = decideForTest(compiled, t);
    let compliant = false;
    if (decision.allowed) {
      compliant = grants.some(
        (g) =>
          g.startMs <= t &&
          t < g.endMs &&
          (!decision.requiresApproval || g.approved) &&
          t < g.startMs + decision.maxSessionMs,
      );
    }
    if (!compliant) {
      const last = result[result.length - 1];
      if (last && last.endMs === s) last.endMs = e;
      else result.push({ startMs: s, endMs: e });
    }
  }
  return result;
}
