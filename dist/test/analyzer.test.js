import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDrift } from '../src/analyzer.js';
const H = 3_600_000;
const M = 60_000;
const ALL_DAY = { start: '12:00 AM', end: '12:00 AM' };
// 审计时刻：2026-01-15T23:00:00.000Z（UTC 整数毫秒）
const AUDIT = Date.UTC(2026, 0, 15, 23, 0, 0);
function allowPolicy(id, principal, priority, sessionH, requiresApproval, window = ALL_DAY) {
    return {
        policyId: id,
        principal,
        environmentId: 'e1',
        resourceType: 'rt1',
        effect: 'allow',
        priority,
        window,
        maxSessionMs: sessionH * H,
        requiresApproval,
    };
}
function grant(id, userId, startMs, endMs, approved) {
    return { grantId: id, userId, environmentId: 'e1', resourceType: 'rt1', startMs, endMs, approved };
}
function snapshot(policies, grants) {
    return {
        identities: [
            { userId: 'u1', roles: [], groups: [] },
            { userId: 'u2', roles: [], groups: [] },
        ],
        environments: [{ environmentId: 'e1', resourceTypes: ['rt1'] }],
        policies,
        grants,
        auditMs: AUDIT,
    };
}
function iv(userId, startMs, endMs) {
    return { userId, environmentId: 'e1', resourceType: 'rt1', startMs, endMs };
}
test('验收：拒绝窗口 11:59PM-12:01AM 仅报告这两分钟', () => {
    const policies = [
        allowPolicy('a1', { kind: 'user', id: 'u1' }, 1, 8, false),
        {
            policyId: 'd1',
            principal: { kind: 'user', id: 'u1' },
            environmentId: 'e1',
            resourceType: 'rt1',
            effect: 'deny',
            priority: 1000,
            window: { start: '11:59 PM', end: '12:01 AM' },
        },
    ];
    // 授权覆盖 23:59 与 00:01 两个边界
    const grants = [grant('g1', 'u1', AUDIT - H, AUDIT + 2 * H, false)];
    const result = analyzeDrift(snapshot(policies, grants));
    assert.deepEqual(result, [iv('u1', AUDIT + 59 * M, AUDIT + 61 * M)]);
});
test('同级允许冲突：取最短会话、审批取或，且不退回次优策略', () => {
    const policies = [
        allowPolicy('a1', { kind: 'user', id: 'u1' }, 5, 2, false),
        allowPolicy('a2', { kind: 'user', id: 'u1' }, 5, 4, true),
        allowPolicy('a3', { kind: 'user', id: 'u1' }, 9, 8, false),
        allowPolicy('a4', { kind: 'user', id: 'u2' }, 5, 2, false),
        allowPolicy('a5', { kind: 'user', id: 'u2' }, 5, 4, true),
    ];
    const grants = [
        // 未审批：同级存在要求审批的策略 → 从不合规，全程漂移
        grant('g1', 'u1', AUDIT - 30 * M, AUDIT + 5 * H, false),
        // 已审批：合规到 start+2h（最短会话），之后漂移；不得退回 4h/8h 策略
        grant('g2', 'u2', AUDIT - 30 * M, AUDIT + 5 * H, true),
    ];
    const result = analyzeDrift(snapshot(policies, grants));
    assert.deepEqual(result, [
        iv('u1', AUDIT, AUDIT + 5 * H),
        iv('u2', AUDIT + 90 * M, AUDIT + 5 * H),
    ]);
});
test('审批不同的重叠授权与会话上限交错', () => {
    const policies = [
        allowPolicy('a1', { kind: 'user', id: 'u1' }, 1, 1, true),
    ];
    const grants = [
        // 已审批，但会话上限 start+1h = AUDIT+10m 先于到期 AUDIT+30m 耗尽
        grant('g1', 'u1', AUDIT - 50 * M, AUDIT + 30 * M, true),
        // 未审批，从不合规，但提供实际访问到 AUDIT+2h
        grant('g2', 'u1', AUDIT - 10 * M, AUDIT + 2 * H, false),
    ];
    const result = analyzeDrift(snapshot(policies, grants));
    assert.deepEqual(result, [iv('u1', AUDIT + 10 * M, AUDIT + 2 * H)]);
});
test('至少一份合规授权覆盖即不漂移；无实际访问不报告', () => {
    const policies = [
        allowPolicy('a1', { kind: 'user', id: 'u1' }, 1, 8, true),
        allowPolicy('a2', { kind: 'user', id: 'u2' }, 1, 8, true),
    ];
    const grants = [
        grant('g1', 'u1', AUDIT - H, AUDIT + H, false), // 未审批不合规
        grant('g2', 'u1', AUDIT - H, AUDIT + H, true), // 已审批合规覆盖同时段
        grant('g3', 'u2', AUDIT - H, AUDIT + H, true), // 完全合规
    ];
    assert.deepEqual(analyzeDrift(snapshot(policies, grants)), []);
});
