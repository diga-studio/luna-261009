import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, type SettlementRequest, type WorkInterval } from "../src/index.js";

const H = 3600;

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Helsinki",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Anchorage",
  "Asia/Dubai",
];

// 确定性伪随机数，保证测试可重复。
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

test("性能：5000 员工 / 50 地点 / 20 万区间在 10 秒内完成", { timeout: 60_000 }, () => {
  const rand = mulberry32(42);
  const employeeTimeZone = "America/New_York";
  const weekStartLocalDate = "2025-03-03";
  // 周起点：纽约 2025-03-03 00:00 EST = 2025-03-03T05:00:00Z。
  const weekStartUtc = Date.UTC(2025, 2, 3, 5, 0, 0) / 1000;
  const weekEndUtc = weekStartUtc + 7 * 24 * H;

  const locationTimeZones: Record<string, string> = {};
  const holidayRates: Record<string, Record<string, 1.5 | 2>> = {};
  for (let l = 0; l < 50; l++) {
    const id = `LOC${l}`;
    locationTimeZones[id] = TIMEZONES[l % TIMEZONES.length];
    const dates: Record<string, 1.5 | 2> = {};
    for (let d = 0; d < 7; d++) {
      if (rand() < 0.2) {
        const date = new Date((weekStartUtc + d * 24 * H) * 1000)
          .toISOString()
          .slice(0, 10);
        dates[date] = rand() < 0.5 ? 1.5 : 2;
      }
    }
    holidayRates[id] = dates;
  }

  const intervals: WorkInterval[] = [];
  let expectedTotal = 0;
  const push = (employeeId: string, sourceId: string, locationId: string, s: number, e: number) => {
    intervals.push({ employeeId, sourceId, locationId, startUtc: s, endUtc: e });
    expectedTotal += e - s;
  };

  // 100 名员工整周连续工作（168h 单区间）。
  for (let e = 0; e < 100; e++) {
    push(`EMP${e}`, `SRC-WEEK-${e}`, `LOC${e % 50}`, weekStartUtc, weekEndUtc);
  }
  // 其余员工大量短区间，直至区间总数达到 20 万。
  let n = intervals.length;
  let empIdx = 100;
  while (n < 200_000) {
    const employeeId = `EMP${empIdx}`;
    let cursor = weekStartUtc + Math.floor(rand() * 12 * H);
    const count = 1 + Math.floor(rand() * 60);
    for (let k = 0; k < count && n < 200_000; k++) {
      const dur = 300 + Math.floor(rand() * 3 * H);
      const end = Math.min(cursor + dur, weekEndUtc);
      if (end > cursor) {
        push(employeeId, `SRC-${empIdx}-${k}`, `LOC${Math.floor(rand() * 50)}`, cursor, end);
        n++;
      }
      cursor = end + Math.floor(rand() * 20 * H);
      if (cursor >= weekEndUtc) break;
    }
    empIdx = (empIdx + 1) % 5000;
    if (empIdx < 100) empIdx = 100;
  }

  const req: SettlementRequest = {
    weekStartLocalDate,
    employeeTimeZone,
    initialContinuousSeconds: 2 * H,
    locationTimeZones,
    holidayRates,
    intervals,
  };

  const started = performance.now();
  const res = settle(req);
  const elapsedMs = performance.now() - started;

  let segmentTotal = 0;
  let rateTotal = 0;
  for (const emp of res.employees) {
    for (const s of emp.segments) {
      segmentTotal += s.endUtc - s.startUtc;
      assert.ok(s.rate === 1 || s.rate === 1.5 || s.rate === 2);
    }
    rateTotal +=
      emp.totalSecondsByRate.rate1 +
      emp.totalSecondsByRate.rate1_5 +
      emp.totalSecondsByRate.rate2;
  }
  assert.equal(segmentTotal, expectedTotal);
  assert.equal(rateTotal, expectedTotal);
  console.log(
    `settle: ${intervals.length} intervals, ${res.employees.length} employees, ` +
      `${res.employees.reduce((a, e) => a + e.segments.length, 0)} segments, ${elapsedMs.toFixed(0)}ms`,
  );
  assert.ok(elapsedMs < 10_000, `settle took ${elapsedMs.toFixed(0)}ms`);
});
