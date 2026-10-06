import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, type SettlementRequest, type WorkInterval } from "../src/index.js";

const UTC = "UTC";
const H = 3600;
// 结算周：2025-03-03（周一）起，UTC。
const WEEK_START = Date.UTC(2025, 2, 3, 0, 0, 0) / 1000;

function baseRequest(intervals: WorkInterval[], initialContinuousSeconds = 0): SettlementRequest {
  return {
    weekStartLocalDate: "2025-03-03",
    employeeTimeZone: UTC,
    initialContinuousSeconds,
    locationTimeZones: { L1: UTC },
    holidayRates: {},
    intervals,
  };
}

function iv(dayOffset: number, startHour: number, endHour: number, sourceId: string): WorkInterval {
  return {
    employeeId: "E1",
    sourceId,
    locationId: "L1",
    startUtc: WEEK_START + dayOffset * 24 * H + startHour * H,
    endUtc: WEEK_START + dayOffset * 24 * H + endHour * H,
  };
}

test("同一区间跨过日、周、连续三道加班门槛", () => {
  // 周一至周四每天 09:00-18:00（9h）：每日 8h@1 + 1h@1.5，周累计达 36h。
  // 周六 00:00-16:00 连续 16h：
  //   00:00-04:00 率1（周累计 36->40）
  //   04:00-12:00 率1.5（周超 40h；期间日累计也超 8h）
  //   12:00-16:00 率2（连续超 12h）
  const intervals = [
    iv(0, 9, 18, "mon"),
    iv(1, 9, 18, "tue"),
    iv(2, 9, 18, "wed"),
    iv(3, 9, 18, "thu"),
    iv(5, 0, 16, "sat"),
  ];
  const res = settle(baseRequest(intervals));
  const emp = res.employees[0];
  assert.equal(emp.totalSecondsByRate.rate1, 36 * H);
  assert.equal(emp.totalSecondsByRate.rate1_5, 12 * H);
  assert.equal(emp.totalSecondsByRate.rate2, 4 * H);

  const sat = emp.segments.filter((s) => s.sourceId === "sat");
  assert.deepEqual(
    sat.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      [iv(5, 0, 0, "").startUtc, iv(5, 4, 0, "").startUtc, 1],
      [iv(5, 4, 0, "").startUtc, iv(5, 12, 0, "").startUtc, 1.5],
      [iv(5, 12, 0, "").startUtc, iv(5, 16, 0, "").startUtc, 2],
    ],
  );
});

test("期初连续工时衔接从周起点立即开始的工作", () => {
  // 期初已连续 11h，第一段从周起点开始 2h：第 1 小时率1，第 2 小时率2。
  const res = settle(baseRequest([iv(0, 0, 2, "first")], 11 * H));
  const emp = res.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      [WEEK_START, WEEK_START + 1 * H, 1],
      [WEEK_START + 1 * H, WEEK_START + 2 * H, 2],
    ],
  );
});

test("第一段晚于周起点时期初连续工时失效", () => {
  const res = settle(baseRequest([iv(0, 1, 3, "late")], 11 * H));
  const emp = res.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [[iv(0, 1, 0, "").startUtc, iv(0, 3, 0, "").startUtc, 1]],
  );
});

test("相邻首尾相接的区间连续工时不重置", () => {
  // 两段相接各 6.5h，共 13h：前 12h 内 8h@1 + 4h@1.5，最后 1h@2。
  const a = iv(0, 0, 6.5, "a");
  const b: WorkInterval = { ...iv(0, 6.5, 13, "b"), startUtc: a.endUtc };
  const res = settle(baseRequest([b, a])); // 乱序输入
  const emp = res.employees[0];
  assert.equal(emp.totalSecondsByRate.rate1, 8 * H);
  assert.equal(emp.totalSecondsByRate.rate1_5, 4 * H);
  assert.equal(emp.totalSecondsByRate.rate2, 1 * H);
});

test("正长度空档重置连续工时", () => {
  // 两段各 7h，中间空 1 秒：各自连续 7h，不触发 12h 门槛。
  const a = iv(0, 0, 7, "a");
  const b: WorkInterval = { ...iv(0, 7, 14, "b"), startUtc: a.endUtc + 1, endUtc: a.endUtc + 1 + 7 * H };
  const res = settle(baseRequest([a, b]));
  const emp = res.employees[0];
  assert.equal(emp.totalSecondsByRate.rate2, 0);
  // 日累计 14h：8h@1 + 6h@1.5。
  assert.equal(emp.totalSecondsByRate.rate1, 8 * H);
  assert.equal(emp.totalSecondsByRate.rate1_5, 6 * H);
});
