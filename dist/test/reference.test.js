import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDrift } from '../src/analyzer.js';
const H = 3_600_000;
const M = 60_000;
const DAY = 86_400_000;
const AUDIT = Date.UTC(2026, 0, 15, 23, 0, 0); // 2026-01-15T23:00:00Z
// ---------- 独立参考实现（不复用 src 的任何逻辑，逐毫秒扫描） ----------
function refParseTime(text) {
    const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(text);
    let h = Number(m[1]) % 12;
    if (m[3] === 'PM')
        h += 12;
    return h * H + Number(m[2]) * M;
}
function refInWindow(w, t) {
    const s = refParseTime(w.start);
    const e = refParseTime(w.end);
    if (s === e)
        return true;
    const tod = ((t % DAY) + DAY) % DAY;
    return s < e ? tod >= s && tod < e : tod >= s || tod < e;
}
function refPrincipalMatches(p, userId) {
    return p.principal.kind === 'user' && p.principal.id === userId;
}
function refDrift(snapshot) {
    const rangeStart = snapshot.auditMs;
    const rangeEnd = rangeStart + 8 * H;
    const groups = new Map();
    for (const g of snapshot.grants) {
        const key = `${g.userId}|${g.environmentId}|${g.resourceType}`;
        const list = groups.get(key) ?? [];
        list.push(g);
        groups.set(key, list);
    }
    const out = [];
    for (const grants of groups.values()) {
        const g0 = grants[0];
        const policies = snapshot.policies.filter((p) => p.environmentId === g0.environmentId &&
            p.resourceType === g0.resourceType &&
            refPrincipalMatches(p, g0.userId));
        const maxEnd = Math.min(rangeEnd, Math.max(...grants.map((g) => g.endMs)));
        let driftStart = -1;
        for (let t = rangeStart; t < maxEnd; t++) {
            const active = grants.filter((g) => g.startMs <= t && t < g.endMs);
            let drift = false;
            if (active.length > 0) {
                const denied = policies.some((p) => p.effect === 'deny' && refInWindow(p.window, t));
                if (denied) {
                    drift = true;
                }
                else {
                    const allows = policies.filter((p) => p.effect === 'allow' && refInWindow(p.window, t));
                    if (allows.length === 0) {
                        drift = true;
                    }
                    else {
                        const bestPri = Math.min(...allows.map((p) => p.priority));
                        const tier = allows.filter((p) => p.priority === bestPri);
                        const session = Math.min(...tier.map((p) => p.maxSessionMs));
                        const req = tier.some((p) => p.requiresApproval === true);
                        const covered = active.some((g) => (!req || g.approved) && t < g.startMs + session);
                        drift = !covered;
                    }
                }
            }
            if (drift && driftStart < 0)
                driftStart = t;
            if (!drift && driftStart >= 0) {
                out.push({
                    userId: g0.userId,
                    environmentId: g0.environmentId,
                    resourceType: g0.resourceType,
                    startMs: driftStart,
                    endMs: t,
                });
                driftStart = -1;
            }
        }
        if (driftStart >= 0) {
            out.push({
                userId: g0.userId,
                environmentId: g0.environmentId,
                resourceType: g0.resourceType,
                startMs: driftStart,
                endMs: maxEnd,
            });
        }
    }
    return out;
}
// ---------- 组合场景 ----------
function policy(id, userId, effect, priority, window, sessionH, requiresApproval) {
    const base = {
        policyId: id,
        principal: { kind: 'user', id: userId },
        environmentId: 'e1',
        resourceType: 'rt1',
        effect,
        priority,
        window,
    };
    if (sessionH !== undefined)
        base.maxSessionMs = sessionH * H;
    if (requiresApproval !== undefined)
        base.requiresApproval = requiresApproval;
    return base;
}
const ALL_DAY = { start: '12:00 AM', end: '12:00 AM' };
function grant(id, userId, startMs, endMs, approved) {
    return { grantId: id, userId, environmentId: 'e1', resourceType: 'rt1', startMs, endMs, approved };
}
function buildScenario() {
    const policies = [
        // u1：全天 allow + 跨午夜 deny
        policy('p1', 'u1', 'allow', 1, ALL_DAY, 8, false),
        policy('p2', 'u1', 'deny', 1000, { start: '11:59 PM', end: '12:01 AM' }),
        // u2：同级冲突（短会话 + 要求审批）+ 低优先级长会话不得回退
        policy('p3', 'u2', 'allow', 5, ALL_DAY, 1, false),
        policy('p4', 'u2', 'allow', 5, ALL_DAY, 3, true),
        policy('p5', 'u2', 'allow', 9, ALL_DAY, 8, false),
        // u3：仅白天窗口 allow，夜间实际访问即漂移
        policy('p6', 'u3', 'allow', 1, { start: '08:00 AM', end: '08:00 PM' }, 8, false),
        // u4：要求审批的 allow
        policy('p7', 'u4', 'allow', 1, ALL_DAY, 2, true),
    ];
    const grants = [
        // u1：覆盖跨午夜 deny 窗口
        grant('g1', 'u1', AUDIT - 30 * M, AUDIT + 90 * M, false),
        // u2：一份已审批（合规到 start+1h），一份未审批（从不合规）
        grant('g2', 'u2', AUDIT - 45 * M, AUDIT + 30 * M, true),
        grant('g3', 'u2', AUDIT - 10 * M, AUDIT + 75 * M, false),
        // u3：夜间 allow 不生效，直到 08:00 前都漂移（但授权只到 AUDIT+50m）
        grant('g4', 'u3', AUDIT - 20 * M, AUDIT + 50 * M, false),
        // u4：重叠授权，审批状态不同，会话上限交错
        grant('g5', 'u4', AUDIT - 80 * M, AUDIT + 70 * M, true), // 合规到 start+2h=AUDIT+40m
        grant('g6', 'u4', AUDIT - 5 * M, AUDIT + 65 * M, false), // 从不合规
    ];
    return {
        identities: ['u1', 'u2', 'u3', 'u4'].map((userId) => ({
            userId,
            roles: [],
            groups: [],
        })),
        environments: [{ environmentId: 'e1', resourceTypes: ['rt1'] }],
        policies,
        grants,
        auditMs: AUDIT,
    };
}
test('完整结果与独立参考计算一致', () => {
    const snap = buildScenario();
    const expected = refDrift(snap);
    // 参考实现自身应产生非平凡的漂移区间，避免空对比
    assert.ok(expected.length >= 4, `expected drift intervals, got ${expected.length}`);
    const actual = analyzeDrift(snap);
    const sortKey = (d) => `${d.userId}|${d.environmentId}|${d.resourceType}|${d.startMs}`;
    assert.deepEqual(actual.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)), expected.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)));
});
