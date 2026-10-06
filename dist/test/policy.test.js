import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAt } from '../src/policy.js';
const ALL_DAY = { start: '12:00 AM', end: '12:00 AM' };
const H = 3_600_000;
const identity = { userId: 'u1', roles: ['r1'], groups: ['g1'] };
function allow(priority, sessionH, requiresApproval) {
    return {
        policyId: `a${priority}`,
        principal: { kind: 'user', id: 'u1' },
        environmentId: 'e1',
        resourceType: 'rt1',
        effect: 'allow',
        priority,
        window: ALL_DAY,
        maxSessionMs: sessionH * H,
        requiresApproval,
    };
}
test('deny 存在即禁止，不受优先级影响', () => {
    const deny = {
        policyId: 'd1',
        principal: { kind: 'group', id: 'g1' },
        environmentId: 'e1',
        resourceType: 'rt1',
        effect: 'deny',
        priority: 1000,
        window: ALL_DAY,
    };
    const d = decideAt([allow(1, 8, false), deny], identity, 'e1', 'rt1', 0);
    assert.equal(d.allowed, false);
});
test('无 allow 策略时禁止访问', () => {
    const d = decideAt([], identity, 'e1', 'rt1', 0);
    assert.equal(d.allowed, false);
});
test('取最小优先级；同级取最短会话；审批为同级逻辑或', () => {
    const low = allow(9, 8, false);
    const a = allow(5, 4, false);
    const b = { ...allow(5, 2, true), policyId: 'b' };
    const d = decideAt([low, a, b], identity, 'e1', 'rt1', 0);
    assert.equal(d.allowed, true);
    assert.equal(d.maxSessionMs, 2 * H);
    assert.equal(d.requiresApproval, true);
});
test('窗口外策略不生效；角色与组主体可匹配', () => {
    const nightAllow = {
        ...allow(1, 8, false),
        principal: { kind: 'role', id: 'r1' },
        window: { start: '10:00 PM', end: '11:00 PM' },
    };
    const noon = 12 * H;
    assert.equal(decideAt([nightAllow], identity, 'e1', 'rt1', noon).allowed, false);
    assert.equal(decideAt([nightAllow], identity, 'e1', 'rt1', 22 * H).allowed, true);
});
test('环境、资源类型、主体不匹配则不生效', () => {
    const p = allow(1, 8, false);
    assert.equal(decideAt([p], identity, 'e2', 'rt1', 0).allowed, false);
    assert.equal(decideAt([p], identity, 'e1', 'rt2', 0).allowed, false);
    const other = { ...p, principal: { kind: 'user', id: 'u2' } };
    assert.equal(decideAt([other], identity, 'e1', 'rt1', 0).allowed, false);
});
