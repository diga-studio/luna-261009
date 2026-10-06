import { test } from "node:test";
import assert from "node:assert/strict";
import { FacilityZone, Slot, GRID_MS, DAY_MS } from "../src/index";

const DAY = Date.UTC(2026, 2, 10); // 2026-03-10T00:00:00Z
const at = (h: number, m = 0, ms = 0): number =>
  DAY + h * 3_600_000 + m * 60_000 + ms;

function slotAt(slots: Slot[], start: number): Slot | undefined {
  return slots.find((s) => s.start === start);
}

test("handoff at 05:15: adjacent bookings do not overlap, 1ms crosser kills the slot", () => {
  const zone = new FacilityZone({ capacity: 3 });
  zone.upsertBooking("a", at(5, 0), at(5, 15), 2);
  zone.upsertBooking("b", at(5, 15), at(5, 30), 2);

  let slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(5, 0))?.remaining, 1);

  // 1ms on each side of the 05:15 handoff -> max concurrency becomes 3
  zone.upsertBooking("c", at(5, 14, 999), at(5, 15, 1), 1);
  slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(5, 0)), undefined);

  zone.deleteBooking("c");
  slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(5, 0))?.remaining, 1);
});

test("off-grid closure removes intersecting slots but never re-anchors the grid", () => {
  const zone = new FacilityZone({
    capacity: 3,
    closures: [{ start: at(5, 10), end: at(5, 20) }],
  });
  const slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(5, 0)), undefined); // intersects closure
  assert.ok(slotAt(slots, at(5, 30))); // first clean slot, on grid
  for (const s of slots) {
    assert.equal((s.start - at(5, 0)) % GRID_MS, 0, "start stays on grid");
  }

  // Query start not on the grid must not re-anchor either.
  const late = zone.listSlots(at(6, 7), DAY + DAY_MS, GRID_MS);
  assert.equal(late[0].start, at(6, 30));

  // 60-minute slots are still enumerated from the original 30-minute grid.
  const hourly = zone.listSlots(DAY, DAY + DAY_MS, 2 * GRID_MS);
  assert.equal(slotAt(hourly, at(5, 0)), undefined); // hits closure
  assert.ok(slotAt(hourly, at(5, 30))); // clean, starts on the 30-min grid
  assert.ok(slotAt(hourly, at(6, 30)));
});

test("upsert replaces time and units; delete frees; pre-range booking counts", () => {
  const zone = new FacilityZone({ capacity: 5 });
  zone.upsertBooking("x", at(10, 0), at(11, 0), 2);
  let slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(10, 0))?.remaining, 3);

  // Replace: new time, new units. Old range must be fully freed.
  zone.upsertBooking("x", at(14, 0), at(15, 0), 4);
  slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(10, 0))?.remaining, 5, "old range freed");
  assert.equal(slotAt(slots, at(14, 0))?.remaining, 1, "new range occupied");

  // Long booking starting before the query range still occupies.
  zone.upsertBooking("y", DAY - 4 * 3_600_000, at(6, 0), 1);
  slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(5, 30))?.remaining, 4);
  assert.equal(slotAt(slots, at(6, 0))?.remaining, 5, "ends exactly at 06:00");

  zone.deleteBooking("x");
  slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(14, 0))?.remaining, 5, "delete frees new range");
  assert.equal(slotAt(slots, at(5, 30))?.remaining, 4, "y untouched");

  zone.deleteBooking("does-not-exist"); // no-op, no throw
  assert.equal(slotAt(zone.listSlots(DAY, DAY + DAY_MS, GRID_MS), at(5, 30))?.remaining, 4);
});

test("closed dates block the whole UTC day; slots stay inside business hours", () => {
  const zone = new FacilityZone({ capacity: 2, closedDates: [at(13, 45)] });
  assert.deepEqual(zone.listSlots(DAY, DAY + DAY_MS, GRID_MS), []);

  const next = zone.listSlots(DAY + DAY_MS, DAY + 2 * DAY_MS, GRID_MS);
  assert.equal(next[0].start, DAY + DAY_MS + 5 * 3_600_000);
  const last = next[next.length - 1];
  assert.equal(last.end, DAY + DAY_MS + 21 * 3_600_000);
  assert.equal(next.length, 32); // 16 business hours / 30min
});

test("slots must be fully inside the query range; invalid duration throws", () => {
  const zone = new FacilityZone({ capacity: 1 });
  const slots = zone.listSlots(at(5, 15), at(6, 0), GRID_MS);
  assert.deepEqual(slots.map((s) => s.start), [at(5, 30)]);
  assert.deepEqual(zone.listSlots(at(5, 15), at(5, 45), GRID_MS), []);
  assert.throws(() => zone.listSlots(DAY, DAY + DAY_MS, 45 * 60_000));
  assert.throws(() => zone.listSlots(DAY, DAY + DAY_MS, 0));
});

test("over-capacity occupancy reports zero by omission, never negative", () => {
  const zone = new FacilityZone({ capacity: 1 });
  zone.upsertBooking("big", at(9, 0), at(10, 0), 5); // not rejected
  const slots = zone.listSlots(DAY, DAY + DAY_MS, GRID_MS);
  assert.equal(slotAt(slots, at(9, 0)), undefined);
  assert.equal(slotAt(slots, at(9, 30)), undefined);
  assert.equal(slotAt(slots, at(10, 0))?.remaining, 1);
});

test("timeline is limited to 2025..2034", () => {
  const zone = new FacilityZone({ capacity: 1 });
  const before = Date.UTC(2024, 11, 31, 5, 0);
  assert.deepEqual(zone.listSlots(before, before + 12 * 3_600_000, GRID_MS), []);
  const first = zone.listSlots(Date.UTC(2024, 6, 1), Date.UTC(2025, 0, 2), GRID_MS);
  assert.equal(first[0].start, Date.UTC(2025, 0, 1, 5, 0));
  const after = Date.UTC(2035, 0, 1);
  assert.deepEqual(zone.listSlots(after, after + DAY_MS, GRID_MS), []);
});
