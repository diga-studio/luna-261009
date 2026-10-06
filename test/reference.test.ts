import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDrift } from '../src/analyze.js';
import { referenceDrift } from './reference.js';
import type { Grant, Policy, Snapshot } from '../src/types.js';

const HOUR = 3_600_000;
const MIN = 60_000;

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

function randomScenario(seed: number): Snapshot {
  const rand = mulberry32(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  const userIds = ['u1', 'u2', 'u3'].slice(0, int(1, 3));
  const roleIds = ['r1', 'r2'];
  const groupIds = ['g1', 'g2'];
  const envIds = ['env1', 'env2'].slice(0, int(1, 2));
  const rts = ['vm', 'db'].slice(0, int(1, 2));

  const audit = Date.UTC(2024, 0, 15) + int(0, 23) * HOUR + int(0, 59) * MIN;

  const identities = userIds.map((id) => ({
    id,
    roleIds: roleIds.filter(() => rand() < 0.5),
    groupIds: groupIds.filter(() => rand() < 0.5),
  }));
  const environments = envIds.map((id) => ({ id, resourceTypes: rts }));

  const fmt = (minutes: number) => {
    const h24 = Math.floor(minutes / 60);
    const m = minutes % 60;
    const suffix = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
  };

  const policies: Policy[] = [];
  const policyCount = int(1, 8);
  for (let i = 0; i < policyCount; i++) {
    const kind = pick(['user', 'role', 'group'] as const);
    const principalId =
      kind === 'user' ? pick(userIds) : kind === 'role' ? pick(roleIds) : pick(groupIds);
    const effect = rand() < 0.3 ? 'deny' : 'allow';
    const w = rand();
    const window =
      w < 0.25
        ? { start: '12:00 AM', end: '12:00 AM' } // 全天
        : { start: fmt(int(0, 1439)), end: fmt(int(0, 1439)) };
    policies.push({
      id: `p${i}`,
      principalKind: kind,
      principalId,
      environmentId: pick(envIds),
      resourceType: pick(rts),
      effect,
      priority: int(1, 6),
      window,
      ...(effect === 'allow'
        ? { maxSessionMs: int(1, 8) * HOUR - int(0, 59) * MIN, requiresApproval: rand() < 0.5 }
        : {}),
    });
  }

  const grants: Grant[] = [];
  const grantCount = int(1, 10);
  for (let i = 0; i < grantCount; i++) {
    const startMs = audit - int(0, 4 * 60) * MIN + (rand() < 0.2 ? int(1, 60) * MIN : 0);
    const duration = int(1, 8 * 60) * MIN;
    grants.push({
      id: `gr${i}`,
      userId: pick(userIds),
      environmentId: pick(envIds),
      resourceType: pick(rts),
      startMs,
      endMs: startMs + duration,
      approved: rand() < 0.5,
    });
  }

  return { identities, environments, policies, grants, auditTimeMs: audit };
}

test('随机场景与独立参考计算结果一致', () => {
  const SCENARIOS = 1000;
  for (let seed = 1; seed <= SCENARIOS; seed++) {
    const snapshot = randomScenario(seed);
    const actual = analyzeDrift(snapshot);

    const expected: ReturnType<typeof analyzeDrift> = [];
    for (const identity of snapshot.identities) {
      for (const env of snapshot.environments) {
        for (const rt of env.resourceTypes) {
          for (const iv of referenceDrift(snapshot, identity.id, env.id, rt)) {
            expected.push({
              userId: identity.id,
              environmentId: env.id,
              resourceType: rt,
              ...iv,
            });
          }
        }
      }
    }
    const key = (r: { userId: string; environmentId: string; resourceType: string; startMs: number; endMs: number }) =>
      `${r.userId}|${r.environmentId}|${r.resourceType}|${r.startMs}|${r.endMs}`;
    assert.deepEqual(
      actual.map(key).sort(),
      expected.map(key).sort(),
      `seed=${seed} 结果不一致
actual=${JSON.stringify(actual)}
expected=${JSON.stringify(expected)}
snapshot=${JSON.stringify(snapshot)}`,
    );
  }
});
