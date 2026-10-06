import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDrift } from '../src/analyze.js';
import type { Grant, Policy, Snapshot } from '../src/types.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY0 = Date.UTC(2024, 0, 15); // 2024-01-15T00:00:00Z

function allow(over: Partial<Policy> = {}): Policy {
  return {
    id: 'allow',
    principalKind: 'user',
    principalId: 'u1',
    environmentId: 'env1',
    resourceType: 'vm',
    effect: 'allow',
    priority: 1,
    window: { start: '12:00 AM', end: '12:00 AM' }, // 全天
    maxSessionMs: 8 * HOUR,
    requiresApproval: false,
    ...over,
  };
}

function deny(over: Partial<Policy> = {}): Policy {
  return {
    id: 'deny',
    principalKind: 'user',
    principalId: 'u1',
    environmentId: 'env1',
    resourceType: 'vm',
    effect: 'deny',
    priority: 1000,
    window: { start: '11:59 PM', end: '12:01 AM' },
    ...over,
  };
}

function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: 'g1',
    userId: 'u1',
    environmentId: 'env1',
    resourceType: 'vm',
    startMs: 0,
    endMs: 0,
    approved: true,
    ...over,
  };
}

function snap(policies: Policy[], grants: Grant[], auditTimeMs: number): Snapshot {
  return {
    identities: [{ id: 'u1', roleIds: [], groupIds: [] }],
    environments: [{ id: 'env1', resourceTypes: ['vm'] }],
    policies,
    grants,
    auditTimeMs,
  };
}

test('验收：拒绝窗口 11:59PM-12:01AM 仅报告跨午夜的两分钟', () => {
  const audit = DAY0 + 20 * HOUR; // 20:00 UTC
  const g = grant({ startMs: audit, endMs: audit + 8 * HOUR });
  const result = analyzeDrift(snap([allow(), deny()], [g], audit));
  assert.deepEqual(result, [
    {
      userId: 'u1',
      environmentId: 'env1',
      resourceType: 'vm',
      startMs: DAY0 + 23 * HOUR + 59 * MIN,
      endMs: DAY0 + 24 * HOUR + 1 * MIN,
    },
  ]);
  assert.equal(result[0].endMs - result[0].startMs, 2 * MIN);
});

test('同级允许冲突：取最短会话时长，不退回次优策略', () => {
  const t0 = DAY0 + 8 * HOUR;
  const policies = [
    allow({ id: 'a1', priority: 5, maxSessionMs: 4 * HOUR }),
    allow({ id: 'a2', priority: 5, maxSessionMs: 2 * HOUR }),
    allow({ id: 'a3', priority: 9, maxSessionMs: 8 * HOUR }),
  ];
  const g = grant({ startMs: t0, endMs: t0 + 8 * HOUR });
  const result = analyzeDrift(snap(policies, [g], t0));
  // 最短会话 2h 耗尽后漂移，且不回落到 priority 9 的 8h 策略
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0 + 2 * HOUR, t0 + 8 * HOUR]],
  );
});

test('同级同长允许：任意一条要求审批则必须审批', () => {
  const t0 = DAY0 + 8 * HOUR;
  const policies = [
    allow({ id: 'a1', priority: 3, maxSessionMs: 2 * HOUR, requiresApproval: true }),
    allow({ id: 'a2', priority: 3, maxSessionMs: 2 * HOUR, requiresApproval: false }),
  ];
  const unapproved = grant({ id: 'g1', startMs: t0, endMs: t0 + HOUR, approved: false });
  const result1 = analyzeDrift(snap(policies, [unapproved], t0));
  assert.deepEqual(
    result1.map((r) => [r.startMs, r.endMs]),
    [[t0, t0 + HOUR]],
  );
  const approved = grant({ id: 'g2', startMs: t0, endMs: t0 + HOUR, approved: true });
  const result2 = analyzeDrift(snap(policies, [approved], t0));
  assert.deepEqual(result2, []);
});

test('审批不同的重叠授权：仅合规授权覆盖的时段不算漂移', () => {
  const t0 = DAY0 + 8 * HOUR;
  const policies = [allow({ requiresApproval: true })];
  const approvedGrant = grant({ id: 'ga', startMs: t0, endMs: t0 + 4 * HOUR, approved: true });
  const plainGrant = grant({ id: 'gb', startMs: t0 + 2 * HOUR, endMs: t0 + 6 * HOUR, approved: false });
  const result = analyzeDrift(snap(policies, [approvedGrant, plainGrant], t0));
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0 + 4 * HOUR, t0 + 6 * HOUR]],
  );
});

test('会话上限交错：多份授权接续覆盖，末端耗尽才漂移', () => {
  const t0 = DAY0 + 8 * HOUR;
  const policies = [allow({ maxSessionMs: 3 * HOUR })];
  const gA = grant({ id: 'ga', startMs: t0, endMs: t0 + 5 * HOUR });
  const gB = grant({ id: 'gb', startMs: t0 + 2 * HOUR, endMs: t0 + 6 * HOUR });
  const result = analyzeDrift(snap(policies, [gA, gB], t0));
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0 + 5 * HOUR, t0 + 6 * HOUR]],
  );
});

test('无允许策略时禁止访问，整段访问窗口均为漂移', () => {
  const t0 = DAY0 + 8 * HOUR;
  const g = grant({ startMs: t0, endMs: t0 + 2 * HOUR });
  const result = analyzeDrift(snap([], [g], t0));
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0, t0 + 2 * HOUR]],
  );
});

test('拒绝策略无视优先级压过允许策略', () => {
  const t0 = DAY0 + 8 * HOUR;
  const policies = [
    allow({ priority: 1 }),
    deny({ priority: 1000, window: { start: '10:00 AM', end: '11:00 AM' } }),
  ];
  const g = grant({ startMs: t0, endMs: t0 + 4 * HOUR }); // 08:00-12:00
  const result = analyzeDrift(snap(policies, [g], t0));
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0 + 2 * HOUR, t0 + 3 * HOUR]],
  );
});

test('分析范围外不报告：漂移区间被截断在审计后 8 小时', () => {
  const t0 = DAY0 + 8 * HOUR;
  const g = grant({ startMs: t0, endMs: t0 + 8 * HOUR });
  // 无策略 → 全程漂移，但只到 horizon 为止
  const result = analyzeDrift(snap([], [g], t0));
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0, t0 + 8 * HOUR]],
  );
});

test('角色与组上的策略同样生效', () => {
  const t0 = DAY0 + 8 * HOUR;
  const snapshot = snap(
    [
      allow({ principalKind: 'role', principalId: 'r1', maxSessionMs: HOUR }),
      deny({
        principalKind: 'group',
        principalId: 'g1',
        window: { start: '09:00 AM', end: '10:00 AM' },
      }),
    ],
    [grant({ startMs: t0, endMs: t0 + 4 * HOUR })],
    t0,
  );
  snapshot.identities[0].roleIds = ['r1'];
  snapshot.identities[0].groupIds = ['g1'];
  const result = analyzeDrift(snapshot);
  // 会话 1h 耗尽：t0+1h 起漂移；09:00-10:00 拒绝窗口与漂移段首尾相接被合并
  assert.deepEqual(
    result.map((r) => [r.startMs, r.endMs]),
    [[t0 + HOUR, t0 + 4 * HOUR]],
  );
});
