import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, type SettlementRequest, type WorkInterval } from "../src/index.js";

const H = 3600;
const UTC = "UTC";
const NY = "America/New_York";
const SH = "Asia/Shanghai";

function segmentSum(req: SettlementRequest): { seg: number; input: number } {
  const res = settle(req);
  let seg = 0;
  for (const e of res.employees) {
    for (const s of e.segments) seg += s.endUtc - s.startUtc;
  }
  const input = req.intervals.reduce((acc, i) => acc + (i.endUtc - i.startUtc), 0);
  return { seg, input };
}

test("节日日界线按地点时区、日累计日界线按员工时区", () => {
  // 员工会计时区纽约，工作地点上海；上海 2025-03-04 标记 2 倍。
  // 工作 UTC 2025-03-03 12:00-20:00（8h）：
  //   纽约当地 03-03 07:00-15:00（同一员工日，日累计不越界）
  //   上海当地 03-03 20:00 - 03-04 04:00，上海日界线在 UTC 16:00。
  const start = Date.UTC(2025, 2, 3, 12, 0, 0) / 1000;
  const mid = Date.UTC(2025, 2, 3, 16, 0, 0) / 1000; // 上海 03-04 00:00
  const end = Date.UTC(2025, 2, 3, 20, 0, 0) / 1000;
  const req: SettlementRequest = {
    weekStartLocalDate: "2025-03-03",
    employeeTimeZone: NY,
    initialContinuousSeconds: 0,
    locationTimeZones: { L1: SH },
    holidayRates: { L1: { "2025-03-04": 2 } },
    intervals: [
      { employeeId: "E1", sourceId: "S1", locationId: "L1", startUtc: start, endUtc: end },
    ],
  };
  const res = settle(req);
  const emp = res.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      [start, mid, 1],
      [mid, end, 2],
    ],
  );
  assert.equal(emp.totalSecondsByRate.rate1, 4 * H);
  assert.equal(emp.totalSecondsByRate.rate2, 4 * H);
  const sums = segmentSum(req);
  assert.equal(sums.seg, sums.input);
});

test("节日高倍率工时推动后续非节日时间命中周加班", () => {
  // UTC。周一 2025-03-03 节日 2 倍。周一至周五每天 09:00-17:00（8h），
  // 周六 09:00-11:00（2h）。周一 8h 按 2 倍计费但仍计入周累计，
  // 周五结束时周累计满 40h，周六 2h 为周加班 1.5 倍。
  const weekStart = Date.UTC(2025, 2, 3, 0, 0, 0) / 1000;
  const intervals: WorkInterval[] = [];
  for (let d = 0; d < 5; d++) {
    intervals.push({
      employeeId: "E1",
      sourceId: `day${d}`,
      locationId: "L1",
      startUtc: weekStart + d * 24 * H + 9 * H,
      endUtc: weekStart + d * 24 * H + 17 * H,
    });
  }
  intervals.push({
    employeeId: "E1",
    sourceId: "sat",
    locationId: "L1",
    startUtc: weekStart + 5 * 24 * H + 9 * H,
    endUtc: weekStart + 5 * 24 * H + 11 * H,
  });
  const req: SettlementRequest = {
    weekStartLocalDate: "2025-03-03",
    employeeTimeZone: UTC,
    initialContinuousSeconds: 0,
    locationTimeZones: { L1: UTC },
    holidayRates: { L1: { "2025-03-03": 2 } },
    intervals,
  };
  const res = settle(req);
  const emp = res.employees[0];
  assert.equal(emp.totalSecondsByRate.rate2, 8 * H); // 周一节日
  assert.equal(emp.totalSecondsByRate.rate1, 32 * H); // 周二至周五
  assert.equal(emp.totalSecondsByRate.rate1_5, 2 * H); // 周六周加班
  const sat = emp.segments.filter((s) => s.sourceId === "sat");
  assert.deepEqual(
    sat.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [[weekStart + 5 * 24 * H + 9 * H, weekStart + 5 * 24 * H + 11 * H, 1.5]],
  );
  const sums = segmentSum(req);
  assert.equal(sums.seg, sums.input);
});

test("未标记日期为 1 倍且倍率取最大值不相乘", () => {
  // 地点节日 1.5 倍，同时连续工作超 12h 触发 2 倍：最终取 2，不取 3。
  const weekStart = Date.UTC(2025, 2, 3, 0, 0, 0) / 1000;
  const req: SettlementRequest = {
    weekStartLocalDate: "2025-03-03",
    employeeTimeZone: UTC,
    initialContinuousSeconds: 0,
    locationTimeZones: { L1: UTC },
    holidayRates: { L1: { "2025-03-03": 1.5 } },
    intervals: [
      {
        employeeId: "E1",
        sourceId: "S1",
        locationId: "L1",
        startUtc: weekStart,
        endUtc: weekStart + 13 * H,
      },
    ],
  };
  const res = settle(req);
  const emp = res.employees[0];
  // 0-8h: max(1.5 节日) = 1.5；8-12h: max(1.5, 1.5 日加班) = 1.5；12-13h: max(1.5, 2 连续) = 2。
  assert.equal(emp.totalSecondsByRate.rate1, 0);
  assert.equal(emp.totalSecondsByRate.rate1_5, 12 * H);
  assert.equal(emp.totalSecondsByRate.rate2, 1 * H);
  const sums = segmentSum(req);
  assert.equal(sums.seg, sums.input);
});
