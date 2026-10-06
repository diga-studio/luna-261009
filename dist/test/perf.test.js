import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { analyzeDrift } from '../src/analyzer.js';
const H = 3_600_000;
const M = 60_000;
const AUDIT = Date.UTC(2026, 0, 15, 23, 0, 0);
/** 确定性 PRNG（mulberry32） */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomTimeOfDay(rand) {
    const minutes = Math.floor(rand() * 1440);
    const h24 = Math.floor(minutes / 60);
    const mm = minutes % 60;
    const suffix = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${String(h12).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${suffix}`;
}
function buildSnapshot() {
    const rand = rng(20261007);
    const USER_COUNT = 5000;
    const ENV_COUNT = 50;
    const RT_PER_ENV = 20;
    const POLICY_COUNT = 20000;
    const GRANT_COUNT = 100000;
    const ROLE_POOL = 40;
    const GROUP_POOL = 40;
    const identities = Array.from({ length: USER_COUNT }, (_, i) => {
        const roles = new Set();
        const groups = new Set();
        while (roles.size < 8)
            roles.add(`role-${Math.floor(rand() * ROLE_POOL)}`);
        while (groups.size < 8)
            groups.add(`grp-${Math.floor(rand() * GROUP_POOL)}`);
        return { userId: `user-${i}`, roles: [...roles], groups: [...groups] };
    });
    const environments = Array.from({ length: ENV_COUNT }, (_, i) => ({
        environmentId: `env-${i}`,
        resourceTypes: Array.from({ length: RT_PER_ENV }, (_, j) => `rt-${j}`),
    }));
    const policies = [];
    for (let i = 0; i < POLICY_COUNT; i++) {
        const env = environments[Math.floor(rand() * ENV_COUNT)];
        const resourceType = env.resourceTypes[Math.floor(rand() * RT_PER_ENV)];
        const kindPick = rand();
        const principal = kindPick < 0.4
            ? { kind: 'user', id: `user-${Math.floor(rand() * USER_COUNT)}` }
            : kindPick < 0.7
                ? { kind: 'role', id: `role-${Math.floor(rand() * ROLE_POOL)}` }
                : { kind: 'group', id: `grp-${Math.floor(rand() * GROUP_POOL)}` };
        const effect = rand() < 0.2 ? 'deny' : 'allow';
        const start = randomTimeOfDay(rand);
        const end = rand() < 0.15 ? start : randomTimeOfDay(rand); // 部分全天
        const policy = {
            policyId: `pol-${i}`,
            principal,
            environmentId: env.environmentId,
            resourceType,
            effect,
            priority: 1 + Math.floor(rand() * 1000),
            window: { start, end },
        };
        if (effect === 'allow') {
            policy.maxSessionMs = (1 + Math.floor(rand() * 8)) * H;
            policy.requiresApproval = rand() < 0.5;
        }
        policies.push(policy);
    }
    const grants = [];
    for (let i = 0; i < GRANT_COUNT; i++) {
        const env = environments[Math.floor(rand() * ENV_COUNT)];
        const startMs = AUDIT - Math.floor(rand() * 4 * H);
        const maxRemaining = 8 * H - (AUDIT - startMs);
        const endMs = AUDIT + 1 + Math.floor(rand() * (maxRemaining - 1));
        grants.push({
            grantId: `g-${i}`,
            userId: `user-${Math.floor(rand() * USER_COUNT)}`,
            environmentId: env.environmentId,
            resourceType: env.resourceTypes[Math.floor(rand() * RT_PER_ENV)],
            startMs,
            endMs,
            approved: rand() < 0.5,
        });
    }
    return { identities, environments, policies, grants, auditMs: AUDIT };
}
test('规模性能：5000 身份 / 50 环境 / 20000 策略 / 100000 授权', () => {
    const snapshot = buildSnapshot();
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const result = analyzeDrift(snapshot);
    const elapsedMs = performance.now() - t0;
    globalThis.gc?.();
    const heapDeltaMiB = (process.memoryUsage().heapUsed - heapBefore) / 2 ** 20;
    console.log(`  [perf] ${elapsedMs.toFixed(0)}ms, heap +${heapDeltaMiB.toFixed(1)} MiB, ` +
        `${result.length} drift intervals`);
    assert.ok(result.length <= 200000, `intervals ${result.length} > 200000`);
    assert.ok(elapsedMs < 10_000, `elapsed ${elapsedMs}ms >= 10s`);
    assert.ok(heapDeltaMiB < 256, `heap delta ${heapDeltaMiB} MiB >= 256`);
    for (const d of result) {
        assert.ok(d.startMs >= AUDIT && d.endMs <= AUDIT + 8 * H);
        assert.ok(d.endMs > d.startMs);
        assert.equal(d.startMs % 1, 0);
        assert.equal(d.endMs % 1, 0);
    }
});
