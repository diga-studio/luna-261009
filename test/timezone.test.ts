import { test } from "node:test";
import assert from "node:assert/strict";
import { TimeZoneCache } from "../dist/timezone.js";

const NY = "America/New_York";

test("纽约 2025-03-09（夏令时开始）当地 00:00 至 04:00 为 3 个真实小时", () => {
  const tz = new TimeZoneCache();
  const start = tz.dayStartUtcMs(NY, "2025-03-09");
  assert.equal(new Date(start).toISOString(), "2025-03-09T05:00:00.000Z");
  const fourAm = Date.parse("2025-03-09T08:00:00Z"); // 当地 04:00 EDT
  assert.equal(tz.localDate(NY, fourAm - 1), "2025-03-09");
  assert.equal((fourAm - start) / 3_600_000, 3);
});

test("纽约 2025-11-02（夏令时结束）当地 00:00 至 04:00 为 5 个真实小时", () => {
  const tz = new TimeZoneCache();
  const start = tz.dayStartUtcMs(NY, "2025-11-02");
  assert.equal(new Date(start).toISOString(), "2025-11-02T04:00:00.000Z");
  const fourAm = Date.parse("2025-11-02T09:00:00Z"); // 当地 04:00 EST
  assert.equal((fourAm - start) / 3_600_000, 5);
});

test("普通日期当地零点与 localDate 互相一致", () => {
  const tz = new TimeZoneCache();
  const start = tz.dayStartUtcMs("Asia/Shanghai", "2025-01-15");
  assert.equal(new Date(start).toISOString(), "2025-01-14T16:00:00.000Z");
  assert.equal(tz.localDate("Asia/Shanghai", start), "2025-01-15");
  assert.equal(tz.localDate("Asia/Shanghai", start - 1), "2025-01-14");
});

test("缓存：重复查询同一日期返回相同结果", () => {
  const tz = new TimeZoneCache();
  const a = tz.dayStartUtcMs(NY, "2025-03-09");
  const b = tz.dayStartUtcMs(NY, "2025-03-09");
  assert.equal(a, b);
});
