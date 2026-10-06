import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeOfDay, isInWindow } from '../src/timeWindow.js';

const DAY = 86_400_000;

test('parseTimeOfDay: 12 小时制边界', () => {
  assert.equal(parseTimeOfDay('12:00 AM'), 0);
  assert.equal(parseTimeOfDay('12:00 PM'), 720);
  assert.equal(parseTimeOfDay('11:59 PM'), 1439);
  assert.equal(parseTimeOfDay('12:01 AM'), 1);
  assert.equal(parseTimeOfDay('01:30 PM'), 810);
  assert.equal(parseTimeOfDay('1:05 AM'), 65);
});

test('parseTimeOfDay: 非法输入抛错', () => {
  assert.throws(() => parseTimeOfDay('13:00 PM'));
  assert.throws(() => parseTimeOfDay('00:30 AM'));
  assert.throws(() => parseTimeOfDay('10:60 AM'));
  assert.throws(() => parseTimeOfDay('10:00'));
  assert.throws(() => parseTimeOfDay('10:00 pm'));
});

test('isInWindow: 普通窗口起点含终点不含', () => {
  const w = { start: '09:00 AM', end: '05:00 PM' };
  assert.equal(isInWindow(w, 9 * 3600_000), true);
  assert.equal(isInWindow(w, 17 * 3600_000 - 1), true);
  assert.equal(isInWindow(w, 17 * 3600_000), false);
  assert.equal(isInWindow(w, 8 * 3600_000), false);
});

test('isInWindow: 跨午夜窗口', () => {
  const w = { start: '11:59 PM', end: '12:01 AM' };
  assert.equal(isInWindow(w, 23 * 3600_000 + 59 * 60_000), true);
  assert.equal(isInWindow(w, DAY - 1), true);
  assert.equal(isInWindow(w, 0), true);
  assert.equal(isInWindow(w, 60_000), false);
  assert.equal(isInWindow(w, 23 * 3600_000 + 58 * 60_000), false);
  // 任意天的同一时刻
  assert.equal(isInWindow(w, 3 * DAY + 30_000), true);
});

test('isInWindow: 起终相等为全天', () => {
  const w = { start: '08:00 AM', end: '08:00 AM' };
  assert.equal(isInWindow(w, 0), true);
  assert.equal(isInWindow(w, 12345678), true);
});
