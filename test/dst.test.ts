import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, type SettlementRequest } from "../src/index.js";

const NY = "America/New_York";

function totalSeconds(req: SettlementRequest): number {
  const res = settle(req);
  const emp = res.employees[0];
  return (
    emp.totalSecondsByRate.rate1 +
    emp.totalSecondsByRate.rate1_5 +
    emp.totalSecondsByRate.rate2
  );
}

test("纽约 2025-03-09（拨快）当地 00:00-04:00 实际 3 小时", () => {
  // 当地 00:00 EST = 05:00Z；当地 04:00 EDT = 08:00Z。
  const start = Date.UTC(2025, 2, 9, 5, 0, 0) / 1000;
  const end = Date.UTC(2025, 2, 9, 8, 0, 0) / 1000;
  const seconds = totalSeconds({
    weekStartLocalDate: "2025-03-03",
    employeeTimeZone: NY,
    initialContinuousSeconds: 0,
    locationTimeZones: { L1: NY },
    holidayRates: {},
    intervals: [
      { employeeId: "E1", sourceId: "S1", locationId: "L1", startUtc: start, endUtc: end },
    ],
  });
  assert.equal(seconds, 3 * 3600);
});

test("纽约 2025-11-02（拨回）当地 00:00-04:00 实际 5 小时", () => {
  // 当地 00:00 EDT = 04:00Z；当地 04:00 EST = 09:00Z。
  const start = Date.UTC(2025, 10, 2, 4, 0, 0) / 1000;
  const end = Date.UTC(2025, 10, 2, 9, 0, 0) / 1000;
  const seconds = totalSeconds({
    weekStartLocalDate: "2025-10-27",
    employeeTimeZone: NY,
    initialContinuousSeconds: 0,
    locationTimeZones: { L1: NY },
    holidayRates: {},
    intervals: [
      { employeeId: "E1", sourceId: "S1", locationId: "L1", startUtc: start, endUtc: end },
    ],
  });
  assert.equal(seconds, 5 * 3600);
});
