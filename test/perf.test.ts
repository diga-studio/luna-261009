import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDrift } from '../src/analyze.js';
import type { Grant, Policy, Snapshot } from '../src/types.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const MIB = 1024 * 1024;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 达到验收规模的快照：5000 身份 / 50 环境 / 20000 策略 / 100000 授权。 */
function largeSnapshot(): Snapshot {
  const rand = mulberry32(20240115);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

  const envCount = 50;
  const rtsPerEnv = 4;
  const userCount = 5000;
  const roleCount = 500;
  const groupCount = 500;
  const policyCount = 20000;
  const grantCount = 100000;

  const envIds = Array.from({ length: envCount }, (_, i) => `env${i}`);
  const rtIds = Array.from({ length: rtsPerEnv }, (_, i) => `rt${i}`);
  const audit = Date.UTC(2024, 0, 15, 12, 0, 0);

  const identities = Array.from({ length: userCount }, (_, i) => ({
    id: `u${i}`,
    roleIds: Array.from({ length: int(1, 8) }, () => `r${int(0, roleCount - 1)}`),
    groupIds: Array.from({ length: int(1, 8) }, () => `g${int(0, groupCount - 1)}`),
  }));
  const environments = envIds.map((id) => ({ id, resourceTypes: rtIds }));

  const fmt = (minutes: number) => {
    const h24 = Math.floor(minutes / 60);
    const m = minutes % 60;
    const suffix = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
  };

  const policies: Policy[] = Array.from({ length: policyCount }, (_, i) => {
    const kind = pick(['user', 'role', 'group'] as const);
    const principalId =
      kind === 'user'
        ? `u${int(0, userCount - 1)}`
        : kind === 'role'
          ? `r${int(0, roleCount - 1)}`
          : `g${int(0, groupCount - 1)}`;
    const effect = rand() < 0.1 ? 'deny' : 'allow';
    const window =
      rand() < 0.5
        ? { start: '12:00 AM', end: '12:00 AM' }
        : { start: fmt(int(0, 1439)), end: fmt(int(0, 1439)) };
    return {
      id: `p${i}`,
      principalKind: kind,
      principalId,
      environmentId: pick(envIds),
      resourceType: pick(rtIds),
      effect,
      priority: int(1, 1000),
      window,
      ...(effect === 'allow'
        ? { maxSessionMs: int(1, 8) * HOUR, requiresApproval: rand() < 0.3 }
        : {}),
    };
  });

  const grants: Grant[] = Array.from({ length: grantCount }, (_, i) => {
    const startMs = audit - int(0, 7 * 60) * MIN;
    const endMs = Math.max(startMs + int(1, 8 * 60) * MIN, audit + MIN);
    return {
      id: `gr${i}`,
      userId: `u${int(0, userCount - 1)}`,
      environmentId: pick(envIds),
      resourceType: pick(rtIds),
      startMs,
      endMs: Math.min(endMs, startMs + 8 * HOUR),
      approved: rand() < 0.7,
    };
  });

  return { identities, environments, policies, grants, auditTimeMs: audit };
}

test('规模与性能：全量分析 < 10s，新增堆内存 < 256MiB，结果 <= 200000 区间', () => {
  const snapshot = largeSnapshot();
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  const started = performance.now();
  const result = analyzeDrift(snapshot);
  const elapsedMs = performance.now() - started;

  gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMiB = (heapAfter - heapBefore) / MIB;

  console.log(
    `    [perf] ${elapsedMs.toFixed(0)}ms, 结果区间 ${result.length}, ` +
      `堆增量 ${heapDeltaMiB.toFixed(1)} MiB`,
  );
  assert.ok(result.length <= 200_000, `结果区间数 ${result.length} 超过 200000`);
  assert.ok(elapsedMs < 10_000, `耗时 ${elapsedMs.toFixed(0)}ms 超过 10s`);
  if (gc) {
    assert.ok(heapDeltaMiB < 256, `堆增量 ${heapDeltaMiB.toFixed(1)}MiB 超过 256MiB`);
  }
});
