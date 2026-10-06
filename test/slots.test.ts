import { test } from "node:test";
import { equal, deepEqual, ok } from "node:assert/strict";
import { FacilityZone, Slot } from "../src/index";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const BASE = Date.UTC(2026, 2, 10); // 2026-03-10 00:00:00.000 UTC

function at(h: number, m = 0, s = 0, ms = 0): number {
  return BASE + ((h * 60 + m) * 60 + s) * 1000 + ms;
}

function slotAt(slots: Slot[], start: number): Slot | undefined {
  return slots.find((s) => s.start === start);
}

test("交接点两侧的预约不重叠，跨交接点1毫秒的预约使时隙不可用，删除后恢复", () => {
  const zone = new FacilityZone({ capacity: 3 });
  zone.upsertBooking("a", at(5, 0), at(5, 15), 2);
  zone.upsertBooking("b", at(5, 15), at(5, 30), 2);

  let slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(5))?.remaining, 1); // max(2,2)，首尾相接不重叠
  equal(slotAt(slots, at(5, 30))?.remaining, 3);

  // 跨过 05:15 交接点前后各 1 毫秒，占 1 名额
  zone.upsertBooking("c", at(5, 14, 59, 999), at(5, 15, 0, 1), 1);
  slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(5)), undefined); // 峰值 2+1=3，余量 0 不返回
  equal(slotAt(slots, at(5, 30))?.remaining, 3); // 相邻时隙不受影响

  zone.deleteBooking("c");
  slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(5))?.remaining, 1); // 删除后恢复
});

test("非网格边界的闭区不会重锚时隙，60分钟时隙仍从原始30分钟网格枚举", () => {
  const zone = new FacilityZone({
    capacity: 5,
    closures: [{ start: at(5, 10), end: at(5, 50) }],
  });
  const slots = zone.listSlots(at(5), at(8), 60 * MIN);
  // 05:00、05:30 与闭区相交不可用；不会从闭区结束点 05:50 重新起锚
  deepEqual(
    slots.map((s) => s.start),
    [at(6, 0), at(6, 30), at(7, 0)]
  );
  for (const s of slots) {
    equal((s.start - at(5)) % (30 * MIN), 0);
    equal(s.remaining, 5);
  }
});

test("同id覆盖同时改变时间和名额，旧范围无残留、新范围准确，删除后完全恢复", () => {
  const zone = new FacilityZone({ capacity: 4 });
  zone.upsertBooking("x", at(6), at(7), 2);
  equal(slotAt(zone.listSlots(at(5), at(21), 30 * MIN), at(6))?.remaining, 2);

  // 覆盖：时间 06:00-07:00 -> 08:00-09:00，名额 2 -> 3
  zone.upsertBooking("x", at(8), at(9), 3);
  let slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(6))?.remaining, 4, "旧范围不得留下占用");
  equal(slotAt(slots, at(6, 30))?.remaining, 4, "旧范围不得留下占用");
  equal(slotAt(slots, at(8))?.remaining, 1, "新范围按新名额计算");
  equal(slotAt(slots, at(8, 30))?.remaining, 1);

  // 起点早于查询范围的长预约：前一天 20:00 到当天 06:30，占 1 名额
  zone.upsertBooking("y", at(5) - 9 * 60 * MIN, at(6, 30), 1);
  slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(5))?.remaining, 3, "长预约部分覆盖也要计入");
  equal(slotAt(slots, at(6))?.remaining, 3);
  equal(slotAt(slots, at(6, 30))?.remaining, 4, "长预约结束后不再占用");
  equal(slotAt(slots, at(8))?.remaining, 1);

  zone.deleteBooking("x");
  slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(8))?.remaining, 4, "删除后新范围无残留");
  equal(slotAt(slots, at(5))?.remaining, 3, "长预约仍在");

  // 删除不存在的 id 不改变状态
  const before = zone.listSlots(at(5), at(21), 30 * MIN);
  zone.deleteBooking("nobody");
  deepEqual(zone.listSlots(at(5), at(21), 30 * MIN), before);
});

test("关闭日期与跨年预约、时间轴边界", () => {
  const zone = new FacilityZone({ capacity: 2, closedDates: ["2026-03-11"] });
  const closedDay = Date.UTC(2026, 2, 11);
  equal(zone.listSlots(closedDay + 5 * 60 * MIN, closedDay + 21 * 60 * MIN, 30 * MIN).length, 0);
  ok(zone.listSlots(at(5), at(21), 30 * MIN).length > 0, "未关闭的日期正常");

  // 跨年预约：2034-12-31 20:00 -> 2035-01-01 06:00
  const cap1 = new FacilityZone({ capacity: 1 });
  cap1.upsertBooking("ny", Date.UTC(2034, 11, 31, 20), Date.UTC(2035, 0, 1, 6), 1);
  const slots = cap1.listSlots(Date.UTC(2034, 11, 31, 5), Date.UTC(2035, 0, 1), 30 * MIN);
  equal(slotAt(slots, Date.UTC(2034, 11, 31, 19, 30))?.remaining, 1);
  equal(slotAt(slots, Date.UTC(2034, 11, 31, 20)), undefined, "跨年预约占用年末最后时隙");
  equal(slotAt(slots, Date.UTC(2034, 11, 31, 20, 30)), undefined);
  ok(slots.every((s) => s.end <= Date.UTC(2035, 0, 1)), "时隙不超出时间轴");
});

test("超容量占用不拒绝，remaining 负值按 0 处理（不返回）", () => {
  const zone = new FacilityZone({ capacity: 2 });
  zone.upsertBooking("big", at(10), at(11), 5); // 超出容量也照常记录
  const slots = zone.listSlots(at(5), at(21), 30 * MIN);
  equal(slotAt(slots, at(10)), undefined);
  equal(slotAt(slots, at(10, 30)), undefined);
  equal(slotAt(slots, at(11))?.remaining, 2);
});
