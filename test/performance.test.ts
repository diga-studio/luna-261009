import { test } from "node:test";
import assert from "node:assert/strict";
import { settleWeek } from "../dist/index.js";
import type { SettlementInput, WorkInterval } from "../dist/index.js";

const H = 3600;
const WEEK_START_MS = Date.parse("2025-01-06T00:00:00Z"); // 周一（UTC）
const ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildInput(): { input: SettlementInput; expectedSeconds: Map<string, number> } {
  const locationTimeZones: Record<string, string> = {};
  const holidayRates: Record<string, Record<string, 1.5 | 2>> = {};
  for (let i = 0; i < 50; i += 1) {
    locationTimeZones[`LOC${i}`] = ZONES[i % ZONES.length];
    // 一半地点有节日标记，锻炼节日查询路径
    if (i % 2 === 0) {
      holidayRates[`LOC${i}`] = { "2025-01-07": 1.5, "2025-01-09": 2 };
    }
  }

  const employees: SettlementInput["employees"] = [];
  const intervals: WorkInterval[] = [];
  const expectedSeconds = new Map<string, number>();
  let sourceSeq = 0;

  const push = (employeeId: string, locationId: string, startMs: number, endMs: number) => {
    intervals.push({
      employeeId,
      sourceId: `S${sourceSeq++}`,
      locationId,
      startUtc: iso(startMs),
      endUtc: iso(endMs),
    });
    expectedSeconds.set(employeeId, (expectedSeconds.get(employeeId) ?? 0) + (endMs - startMs) / 1000);
  };

  // 50 名员工整周连续工作（168 小时单区间）
  for (let i = 0; i < 50; i += 1) {
    const id = `FULL${i}`;
    employees.push({
      employeeId: id,
      accountingTimeZone: "UTC",
      weekStartLocalDate: "2025-01-06",
      initialContinuousSeconds: 0,
    });
    push(id, `LOC${i}`, WEEK_START_MS, WEEK_START_MS + 7 * 24 * H * 1000);
  }

  // 4950 名员工，每人 41 个 1 小时短区间（共 202950 个）
  const dayHourPatterns = [
    [0, 4, 8, 12, 16, 20],
    [1, 5, 9, 13, 17, 21],
    [2, 6, 10, 14, 18, 22],
    [3, 7, 11, 15, 19, 23],
    [0, 3, 6, 9, 12, 15],
    [1, 4, 7, 10, 13, 16],
    [0, 5, 10, 15, 20],
  ];
  for (let i = 0; i < 4950; i += 1) {
    const id = `E${i}`;
    employees.push({
      employeeId: id,
      accountingTimeZone: "UTC",
      weekStartLocalDate: "2025-01-06",
      initialContinuousSeconds: (i % 5) * H,
    });
    for (let day = 0; day < 7; day += 1) {
      for (const hour of dayHourPatterns[day]) {
        const start = WEEK_START_MS + day * 24 * H * 1000 + hour * H * 1000;
        push(id, `LOC${(i + day) % 50}`, start, start + H * 1000);
      }
    }
  }

  return { input: { employees, locationTimeZones, holidayRates, intervals }, expectedSeconds };
}

test("性能：5000 员工 / 50 地点 / 20 万+ 区间在 10 秒内完成", () => {
  const { input, expectedSeconds } = buildInput();
  assert.equal(input.employees.length, 5000);
  assert.ok(input.intervals.length > 200_000, `intervals=${input.intervals.length}`);

  const startedAt = performance.now();
  const result = settleWeek(input);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 10_000, `settleWeek took ${elapsedMs.toFixed(0)}ms`);

  // 每名员工：明细秒数之和 == 各倍率总量之和 == 输入时长
  for (const emp of result.employees) {
    const segmentSeconds = emp.segments.reduce(
      (acc, s) => acc + (Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 1000,
      0,
    );
    const totalSeconds = emp.totals.regular + emp.totals.timeAndHalf + emp.totals.double;
    const expected = expectedSeconds.get(emp.employeeId) ?? 0;
    assert.equal(segmentSeconds, expected, `segments coverage for ${emp.employeeId}`);
    assert.equal(totalSeconds, expected, `totals coverage for ${emp.employeeId}`);
  }

  // 整周连续工作员工（无节日地点）：8h@1 + 4h@1.5 + 156h@2
  const full0 = result.employees.find((e) => e.employeeId === "FULL0");
  assert.ok(full0);
  assert.deepEqual(full0.totals, { regular: 8 * H, timeAndHalf: 4 * H, double: 156 * H });

  console.log(`settleWeek: ${input.intervals.length} intervals in ${elapsedMs.toFixed(0)}ms`);
});
