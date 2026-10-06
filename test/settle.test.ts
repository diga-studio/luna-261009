import { test } from "node:test";
import assert from "node:assert/strict";
import { settleWeek } from "../dist/index.js";
import type { SettlementInput, SettlementSegment, WorkInterval } from "../dist/index.js";

const WEEK = "2025-01-06"; // 周一
const H = 3600;

function makeInput(overrides: {
  intervals: WorkInterval[];
  accountingTimeZone?: string;
  locationTimeZones?: Record<string, string>;
  holidayRates?: SettlementInput["holidayRates"];
  initialContinuousSeconds?: number;
}): SettlementInput {
  return {
    employees: [
      {
        employeeId: "E1",
        accountingTimeZone: overrides.accountingTimeZone ?? "UTC",
        weekStartLocalDate: WEEK,
        initialContinuousSeconds: overrides.initialContinuousSeconds ?? 0,
      },
    ],
    locationTimeZones: overrides.locationTimeZones ?? { L1: "UTC" },
    holidayRates: overrides.holidayRates ?? {},
    intervals: overrides.intervals,
  };
}

function iv(hoursFromWeekStart: number, lengthHours: number, sourceId = "S", locationId = "L1"): WorkInterval {
  const start = Date.parse("2025-01-06T00:00:00Z") + hoursFromWeekStart * H * 1000;
  return {
    employeeId: "E1",
    sourceId,
    locationId,
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(start + lengthHours * H * 1000).toISOString(),
  };
}

function secondsOf(segments: SettlementSegment[]): number {
  return segments.reduce((acc, s) => acc + (Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 1000, 0);
}

function totalSeconds(totals: { regular: number; timeAndHalf: number; double: number }): number {
  return totals.regular + totals.timeAndHalf + totals.double;
}

test("日累计超过 8 小时的部分为 1.5 倍", () => {
  const result = settleWeek(makeInput({ intervals: [iv(0, 10)] }));
  const emp = result.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-06T00:00:00Z", "2025-01-06T08:00:00Z", 1],
      ["2025-01-06T08:00:00Z", "2025-01-06T10:00:00Z", 1.5],
    ],
  );
  assert.deepEqual(emp.totals, { regular: 8 * H, timeAndHalf: 2 * H, double: 0 });
});

test("一次连续工作超过 12 小时的部分为 2 倍（单区间跨多个门槛）", () => {
  const result = settleWeek(makeInput({ intervals: [iv(0, 14)] }));
  const emp = result.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-06T00:00:00Z", "2025-01-06T08:00:00Z", 1],
      ["2025-01-06T08:00:00Z", "2025-01-06T12:00:00Z", 1.5],
      ["2025-01-06T12:00:00Z", "2025-01-06T14:00:00Z", 2],
    ],
  );
  assert.deepEqual(emp.totals, { regular: 8 * H, timeAndHalf: 4 * H, double: 2 * H });
});

test("周累计超过 40 小时的部分为 1.5 倍", () => {
  // 周一至周五各 9 小时 = 45 小时
  const intervals = [0, 1, 2, 3, 4].map((d) => iv(d * 24, 9, `D${d}`));
  const result = settleWeek(makeInput({ intervals }));
  const emp = result.employees[0];
  // 前 4 天：每天 8h@1 + 1h@1.5（周累计 36h）；周五：4h@1（周累计到 40），之后 5h@1.5
  assert.deepEqual(emp.totals, { regular: 36 * H, timeAndHalf: 9 * H, double: 0 });
  const friday = emp.segments.filter((s) => s.sourceId === "D4");
  assert.deepEqual(
    friday.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-10T00:00:00Z", "2025-01-10T04:00:00Z", 1],
      ["2025-01-10T04:00:00Z", "2025-01-10T08:00:00Z", 1.5],
      ["2025-01-10T08:00:00Z", "2025-01-10T09:00:00Z", 1.5],
    ],
  );
});

test("节日倍率按工作地点时区的当地日期确定", () => {
  // 洛杉矶当地 2025-01-05（周日）为 2 倍节日；UTC 2025-01-06T06:00-07:00 对应 LA 01-05 22:00-23:00
  const result = settleWeek(
    makeInput({
      locationTimeZones: { L1: "America/Los_Angeles" },
      holidayRates: { L1: { "2025-01-05": 2 } },
      intervals: [iv(6, 1)],
    }),
  );
  const emp = result.employees[0];
  assert.deepEqual(emp.segments.map((s) => s.rate), [2]);
  assert.deepEqual(emp.totals, { regular: 0, timeAndHalf: 0, double: 1 * H });
});

test("员工日界线与地点节日日界线不同：同一区间被两种边界切分", () => {
  // 员工 UTC；地点 LA。LA 当地 2025-01-06 为 2 倍节日 = UTC 01-06T08:00 至 01-07T08:00。
  // 区间 UTC 04:00-12:00 共 8 小时：前 4h 非节日 @1，后 4h 节日 @2；日累计恰好 8h 不触发加班。
  const result = settleWeek(
    makeInput({
      locationTimeZones: { L1: "America/Los_Angeles" },
      holidayRates: { L1: { "2025-01-06": 2 } },
      intervals: [iv(4, 8)],
    }),
  );
  const emp = result.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-06T04:00:00Z", "2025-01-06T08:00:00Z", 1],
      ["2025-01-06T08:00:00Z", "2025-01-06T12:00:00Z", 2],
    ],
  );
  assert.deepEqual(emp.totals, { regular: 4 * H, timeAndHalf: 0, double: 4 * H });
});

test("最终倍率取最大值，不相乘（节日 1.5 与日加班 1.5 同时为 1.5；节日 2 保持 2）", () => {
  const result = settleWeek(
    makeInput({
      holidayRates: { L1: { "2025-01-06": 1.5 } },
      intervals: [iv(0, 10)],
    }),
  );
  const emp = result.employees[0];
  assert.deepEqual(emp.totals, { regular: 0, timeAndHalf: 10 * H, double: 0 });

  const result2 = settleWeek(
    makeInput({
      holidayRates: { L1: { "2025-01-06": 2 } },
      intervals: [iv(0, 14)],
    }),
  );
  assert.deepEqual(result2.employees[0].totals, { regular: 0, timeAndHalf: 0, double: 14 * H });
});

test("期初连续工时衔接从周起点立即开始的工作", () => {
  const result = settleWeek(
    makeInput({
      initialContinuousSeconds: 11 * H,
      intervals: [iv(0, 2)],
    }),
  );
  const emp = result.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-06T00:00:00Z", "2025-01-06T01:00:00Z", 1],
      ["2025-01-06T01:00:00Z", "2025-01-06T02:00:00Z", 2],
    ],
  );
  assert.deepEqual(emp.totals, { regular: 1 * H, timeAndHalf: 0, double: 1 * H });
});

test("第一段晚于周起点时，期初连续工时失效", () => {
  const result = settleWeek(
    makeInput({
      initialContinuousSeconds: 11 * H,
      intervals: [iv(1, 2)],
    }),
  );
  assert.deepEqual(result.employees[0].totals, { regular: 2 * H, timeAndHalf: 0, double: 0 });
});

test("正长度空档重置连续工时；日累计不重置", () => {
  // 11h 工作 + 1h 空档 + 2h 工作（同一天）
  const result = settleWeek(makeInput({ intervals: [iv(0, 11, "A"), iv(12, 2, "B")] }));
  const emp = result.employees[0];
  // A：8h@1 + 3h@1.5；空档重置连续；B：日累计已 11h → 2h@1.5，无 2 倍
  assert.deepEqual(emp.totals, { regular: 8 * H, timeAndHalf: 5 * H, double: 0 });
});

test("首尾相接的相邻区间连续工时不重置", () => {
  const result = settleWeek(makeInput({ intervals: [iv(0, 11, "A"), iv(11, 3, "B")] }));
  const emp = result.employees[0];
  // 连续 14h：8h@1，4h@1.5（8-12），2h@2（12-14）
  assert.deepEqual(emp.totals, { regular: 8 * H, timeAndHalf: 4 * H, double: 2 * H });
  const b = emp.segments.filter((s) => s.sourceId === "B");
  assert.deepEqual(
    b.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-06T11:00:00Z", "2025-01-06T12:00:00Z", 1.5],
      ["2025-01-06T12:00:00Z", "2025-01-06T14:00:00Z", 2],
    ],
  );
});

test("节日高倍率工时仍参与周累计，推动后续非节日时间命中周加班", () => {
  // 周一节日 2 倍工作 10h；周二至周五各 8h。周累计：10+8*3=34，周五 8h 中前 6h@1、后 2h@1.5
  const intervals = [iv(0, 10, "MON"), iv(24, 8, "TUE"), iv(48, 8, "WED"), iv(72, 8, "THU"), iv(96, 8, "FRI")];
  const result = settleWeek(
    makeInput({
      holidayRates: { L1: { "2025-01-06": 2 } },
      intervals,
    }),
  );
  const emp = result.employees[0];
  // 周累计含节日 2 倍工时：10+8*3=34h 后，周五前 6h@1、后 2h@1.5
  assert.deepEqual(emp.totals, { regular: 30 * H, timeAndHalf: 2 * H, double: 10 * H });
  const friday = emp.segments.filter((s) => s.sourceId === "FRI");
  assert.deepEqual(
    friday.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-10T00:00:00Z", "2025-01-10T06:00:00Z", 1],
      ["2025-01-10T06:00:00Z", "2025-01-10T08:00:00Z", 1.5],
    ],
  );
});

test("跨午夜区间在日界线切分，日累计归零重算", () => {
  // 周一 20:00 至周二 04:00，共 8h：当天 4h + 次日 4h，均无日加班
  const result = settleWeek(makeInput({ intervals: [iv(20, 8)] }));
  const emp = result.employees[0];
  assert.deepEqual(
    emp.segments.map((s) => [s.startUtc, s.endUtc, s.rate]),
    [
      ["2025-01-06T20:00:00Z", "2025-01-07T00:00:00Z", 1],
      ["2025-01-07T00:00:00Z", "2025-01-07T04:00:00Z", 1],
    ],
  );
  assert.deepEqual(emp.totals, { regular: 8 * H, timeAndHalf: 0, double: 0 });
});

test("换地点不重置连续工时", () => {
  // 两个首尾相接的区间分属不同时区的地点，连续工时照常累计
  const intervals = [iv(0, 11, "A", "L1"), iv(11, 3, "B", "L2")];
  const result = settleWeek(
    makeInput({
      locationTimeZones: { L1: "UTC", L2: "Asia/Shanghai" },
      intervals,
    }),
  );
  assert.deepEqual(result.employees[0].totals, { regular: 8 * H, timeAndHalf: 4 * H, double: 2 * H });
});

test("明细完整覆盖输入：秒数之和等于输入时长，且不重叠", () => {
  const intervals = [iv(0, 14, "A"), iv(30, 9, "B"), iv(55, 26, "C"), iv(100, 3, "D")];
  const result = settleWeek(makeInput({ intervals }));
  const emp = result.employees[0];
  const inputSeconds = intervals.reduce(
    (acc, i) => acc + (Date.parse(i.endUtc) - Date.parse(i.startUtc)) / 1000,
    0,
  );
  assert.equal(secondsOf(emp.segments), inputSeconds);
  assert.equal(totalSeconds(emp.totals), inputSeconds);
  for (let i = 1; i < emp.segments.length; i += 1) {
    assert.ok(Date.parse(emp.segments[i].startUtc) >= Date.parse(emp.segments[i - 1].endUtc));
  }
});

test("纽约夏令时周：3 月 9 日当地 00:00-04:00 计 3 小时实际工时", () => {
  const input = makeInput({
    accountingTimeZone: "America/New_York",
    locationTimeZones: { L1: "America/New_York" },
    intervals: [],
  });
  input.employees[0].weekStartLocalDate = "2025-03-03";
  input.intervals = [
    {
      employeeId: "E1",
      sourceId: "DST1",
      locationId: "L1",
      startUtc: "2025-03-09T05:00:00Z", // 当地 00:00 EST
      endUtc: "2025-03-09T08:00:00Z", // 当地 04:00 EDT
    },
  ];
  const result = settleWeek(input);
  assert.equal(totalSeconds(result.employees[0].totals), 3 * H);
});

test("纽约冬令时回退周：11 月 2 日当地 00:00-04:00 计 5 小时实际工时", () => {
  const input = makeInput({
    accountingTimeZone: "America/New_York",
    locationTimeZones: { L1: "America/New_York" },
    intervals: [],
  });
  input.employees[0].weekStartLocalDate = "2025-10-27";
  input.intervals = [
    {
      employeeId: "E1",
      sourceId: "DST2",
      locationId: "L1",
      startUtc: "2025-11-02T04:00:00Z", // 当地 00:00 EDT
      endUtc: "2025-11-02T09:00:00Z", // 当地 04:00 EST
    },
  ];
  const result = settleWeek(input);
  assert.equal(totalSeconds(result.employees[0].totals), 5 * H);
});
