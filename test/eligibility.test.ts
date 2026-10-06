import { test } from "node:test";
import assert from "node:assert/strict";
import { canOccupy, type OccupancyEntry } from "../src/eligibility.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entry(targetId: string, offsetMs: number): OccupancyEntry {
  return { target: { type: "student", id: targetId }, serviceTimeMs: offsetMs };
}

test("24小时窗口：0/10/23小时已有预约时，12小时拒绝、24小时允许、24小时减1毫秒拒绝", () => {
  const existing = [entry("a", 0), entry("b", 10 * HOUR), entry("c", 23 * HOUR)];
  assert.equal(canOccupy(existing, { type: "student", id: "d" }, 12 * HOUR), false);
  assert.equal(canOccupy(existing, { type: "student", id: "d" }, 24 * HOUR), true);
  assert.equal(
    canOccupy(existing, { type: "student", id: "d" }, 24 * HOUR - 1),
    false,
  );
});

test("24小时窗口包含起点、不包含终点", () => {
  const existing = [entry("a", 0), entry("b", 1 * HOUR), entry("c", 2 * HOUR)];
  assert.equal(canOccupy(existing, { type: "student", id: "d" }, 24 * HOUR), true);
  assert.equal(
    canOccupy(existing, { type: "student", id: "d" }, 24 * HOUR - 1),
    false,
  );
});

test("同一目标相隔14天允许、少1毫秒拒绝", () => {
  const existing = [entry("a", 0)];
  assert.equal(canOccupy(existing, { type: "student", id: "a" }, 14 * DAY), true);
  assert.equal(
    canOccupy(existing, { type: "student", id: "a" }, 14 * DAY - 1),
    false,
  );
});

test("同号学生与班级不是同一目标", () => {
  const existing: OccupancyEntry[] = [
    { target: { type: "student", id: "1" }, serviceTimeMs: 0 },
  ];
  assert.equal(
    canOccupy(existing, { type: "class", id: "1" }, HOUR),
    true,
  );
});
