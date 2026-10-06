import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeOfDay, windowContains } from '../src/timeWindow.js';
const DAY = 86_400_000;
test('parseTimeOfDay: 12:00 AM 为午夜，12:00 PM 为正午', () => {
    assert.equal(parseTimeOfDay('12:00 AM'), 0);
    assert.equal(parseTimeOfDay('12:00 PM'), 12 * 3_600_000);
    assert.equal(parseTimeOfDay('01:30 AM'), 90 * 60_000);
    assert.equal(parseTimeOfDay('11:59 PM'), (23 * 60 + 59) * 60_000);
    assert.equal(parseTimeOfDay('12:01 AM'), 60_000);
});
test('parseTimeOfDay: 非法输入抛错', () => {
    assert.throws(() => parseTimeOfDay('13:00 PM'));
    assert.throws(() => parseTimeOfDay('00:30 AM'));
    assert.throws(() => parseTimeOfDay('10:00'));
    assert.throws(() => parseTimeOfDay('10:60 AM'));
});
test('windowContains: 起点包含、终点不包含', () => {
    const w = { start: '09:00 AM', end: '05:00 PM' };
    assert.equal(windowContains(w, 9 * 3_600_000), true);
    assert.equal(windowContains(w, 17 * 3_600_000 - 1), true);
    assert.equal(windowContains(w, 17 * 3_600_000), false);
    assert.equal(windowContains(w, 8 * 3_600_000), false);
});
test('windowContains: 结束早于开始表示跨午夜', () => {
    const w = { start: '11:59 PM', end: '12:01 AM' };
    const day0 = 10 * DAY;
    assert.equal(windowContains(w, day0 + 23 * 3_600_000 + 59 * 60_000), true);
    assert.equal(windowContains(w, day0 + DAY + 30_000), true); // 次日 00:00:30
    assert.equal(windowContains(w, day0 + DAY + 60_000), false); // 次日 00:01 不含
    assert.equal(windowContains(w, day0 + 12 * 3_600_000), false);
});
test('windowContains: 起终相同表示全天', () => {
    const w = { start: '12:00 AM', end: '12:00 AM' };
    assert.equal(windowContains(w, 0), true);
    assert.equal(windowContains(w, 123_456_789), true);
    assert.equal(windowContains(w, DAY - 1), true);
});
