import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { NotificationLibrary } from "../src/library.js";
import { DAY_MS } from "../src/types.js";

const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function makeLib(): { lib: NotificationLibrary; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(":memory:");
  return { lib: new NotificationLibrary(db), db };
}

function notificationCount(db: ReturnType<typeof openDatabase>): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number };
  return Number(row.n);
}

test("cannot enter sending before the scheduled time", () => {
  const { lib } = makeLib();
  lib.upsertCustomer({ customerId: "c1", lastPurchaseAt: T0, cartNonempty: false, cartUpdatedAt: null }, T0);
  lib.createCampaign({ id: "camp1", title: "t", body: "b", segment: "all", scheduledAt: T0 + DAY_MS });

  const early = lib.advanceCampaign("camp1", T0 + HOUR_MS, 10);
  assert.equal(early.status, "scheduled");
  assert.equal(early.deliveredThisRound, 0);
  assert.equal(lib.getCampaign("camp1")?.status, "scheduled");

  const onTime = lib.advanceCampaign("camp1", T0 + DAY_MS, 10);
  assert.equal(onTime.status, "sent");
  assert.equal(onTime.deliveredThisRound, 1);
});

test("segment boundaries: recent purchase closed interval, stale cart strict 48h", () => {
  const { lib } = makeLib();
  const t = T0;
  const facts = [
    { customerId: "in-lower-bound", lastPurchaseAt: t - 30 * DAY_MS, cartNonempty: false, cartUpdatedAt: null },
    { customerId: "in-upper-bound", lastPurchaseAt: t, cartNonempty: false, cartUpdatedAt: null },
    { customerId: "out-too-old", lastPurchaseAt: t - 30 * DAY_MS - 1, cartNonempty: false, cartUpdatedAt: null },
    { customerId: "out-no-purchase", lastPurchaseAt: null, cartNonempty: false, cartUpdatedAt: null },
    { customerId: "stale-in", lastPurchaseAt: null, cartNonempty: true, cartUpdatedAt: t - 48 * HOUR_MS - 1 },
    { customerId: "stale-out-exact", lastPurchaseAt: null, cartNonempty: true, cartUpdatedAt: t - 48 * HOUR_MS },
    { customerId: "stale-out-empty", lastPurchaseAt: null, cartNonempty: false, cartUpdatedAt: t - 90 * DAY_MS },
  ];
  for (const f of facts) lib.upsertCustomer(f, t);

  lib.createCampaign({ id: "recent", title: "t", body: "b", segment: "recent_purchase", scheduledAt: t });
  lib.createCampaign({ id: "stale", title: "t", body: "b", segment: "stale_cart", scheduledAt: t });
  lib.advanceCampaign("recent", t, 100);
  lib.advanceCampaign("stale", t, 100);

  const recent = lib.listNotifications("in-lower-bound", t).map((n) => n.campaignId);
  assert.deepEqual(recent, ["recent"]);
  assert.equal(lib.listNotifications("in-upper-bound", t).length, 1);
  assert.equal(lib.listNotifications("out-too-old", t).length, 0);
  assert.equal(lib.listNotifications("out-no-purchase", t).length, 0);
  assert.deepEqual(lib.listNotifications("stale-in", t).map((n) => n.campaignId), ["stale"]);
  assert.equal(lib.listNotifications("stale-out-exact", t).length, 0);
  assert.equal(lib.listNotifications("stale-out-empty", t).length, 0);
});

test("audience snapshot is fixed at send start despite later fact changes", () => {
  const { lib } = makeLib();
  const t = T0;
  // Facts as of the moment the campaign enters "sending".
  lib.upsertCustomer({ customerId: "c1", lastPurchaseAt: t - DAY_MS, cartNonempty: false, cartUpdatedAt: null }, t - HOUR_MS);
  lib.upsertCustomer({ customerId: "c2", lastPurchaseAt: t - 60 * DAY_MS, cartNonempty: false, cartUpdatedAt: null }, t - HOUR_MS);
  lib.upsertCustomer({ customerId: "c3", lastPurchaseAt: t - 10 * DAY_MS, cartNonempty: false, cartUpdatedAt: null }, t - HOUR_MS);
  lib.upsertCustomer({ customerId: "c4", lastPurchaseAt: null, cartNonempty: false, cartUpdatedAt: null }, t - HOUR_MS);
  // Independently computed expectation from the facts at time t.
  const expectedRecipients = ["c1", "c3"];

  lib.createCampaign({ id: "camp", title: "promo", body: "hello", segment: "recent_purchase", scheduledAt: t });
  const round1 = lib.advanceCampaign("camp", t, 1);
  assert.equal(round1.status, "sending");
  assert.equal(round1.deliveredThisRound, 1);

  // Between rounds: mutate existing customers and add brand-new ones.
  lib.upsertCustomer({ customerId: "c2", lastPurchaseAt: t + HOUR_MS, cartNonempty: true, cartUpdatedAt: t + HOUR_MS }, t + HOUR_MS);
  lib.upsertCustomer({ customerId: "c4", lastPurchaseAt: t + HOUR_MS, cartNonempty: false, cartUpdatedAt: null }, t + HOUR_MS);
  lib.upsertCustomer({ customerId: "c5-new", lastPurchaseAt: t + HOUR_MS, cartNonempty: false, cartUpdatedAt: null }, t + HOUR_MS);
  lib.upsertCustomer({ customerId: "c6-new", lastPurchaseAt: t + HOUR_MS, cartNonempty: false, cartUpdatedAt: null }, t + HOUR_MS);

  lib.advanceCampaign("camp", t + 2 * HOUR_MS, 100);
  assert.equal(lib.getCampaign("camp")?.status, "sent");

  const delivered = new Set<string>();
  for (const id of ["c1", "c2", "c3", "c4", "c5-new", "c6-new"]) {
    for (const n of lib.listNotifications(id, t + 2 * HOUR_MS)) {
      assert.equal(n.campaignId, "camp");
      assert.ok(!delivered.has(n.customerId), `duplicate notification for ${n.customerId}`);
      delivered.add(n.customerId);
    }
  }
  assert.deepEqual([...delivered].sort(), expectedRecipients);
});

test("expired notifications are purged and remaining recipients complete without delivery", () => {
  const { lib, db } = makeLib();
  const t = T0;
  for (const id of ["c1", "c2", "c3", "c4"]) {
    lib.upsertCustomer({ customerId: id, lastPurchaseAt: t, cartNonempty: false, cartUpdatedAt: null }, t);
  }
  lib.createCampaign({ id: "camp", title: "promo", body: "hello", segment: "all", scheduledAt: t });

  const round1 = lib.advanceCampaign("camp", t, 2);
  assert.equal(round1.deliveredThisRound, 2);
  assert.equal(notificationCount(db), 2);

  // Jump past the 30-day expiry of the campaign's notifications.
  const afterExpiry = t + 30 * DAY_MS + HOUR_MS;
  const round2 = lib.advanceCampaign("camp", afterExpiry, 2);
  assert.equal(round2.purgedThisRound, 2);
  assert.equal(round2.expiredThisRound, 2);
  assert.equal(round2.deliveredThisRound, 0);
  assert.equal(round2.status, "sent");

  // Expired notifications are gone from persistent storage.
  assert.equal(notificationCount(db), 0);
  for (const id of ["c1", "c2", "c3", "c4"]) {
    assert.equal(lib.listNotifications(id, afterExpiry).length, 0);
  }

  // Repeated advances never create more notifications and never regress.
  const round3 = lib.advanceCampaign("camp", afterExpiry + DAY_MS, 100);
  assert.equal(round3.status, "sent");
  assert.equal(round3.deliveredThisRound, 0);
  assert.equal(notificationCount(db), 0);
});

test("notification is readable until but not at its expiry moment", () => {
  const { lib } = makeLib();
  const t = T0;
  lib.upsertCustomer({ customerId: "c1", lastPurchaseAt: t, cartNonempty: false, cartUpdatedAt: null }, t);
  lib.createCampaign({ id: "camp", title: "promo", body: "hello", segment: "all", scheduledAt: t });
  lib.advanceCampaign("camp", t, 10);

  const expiresAt = t + 30 * DAY_MS;
  assert.equal(lib.listNotifications("c1", expiresAt - 1).length, 1);
  assert.equal(lib.listNotifications("c1", expiresAt).length, 0);
});

test("logical time must be monotonically non-decreasing", () => {
  const { lib } = makeLib();
  lib.upsertCustomer({ customerId: "c1", lastPurchaseAt: T0, cartNonempty: false, cartUpdatedAt: null }, T0);
  assert.throws(() => {
    lib.upsertCustomer({ customerId: "c1", lastPurchaseAt: T0, cartNonempty: false, cartUpdatedAt: null }, T0 - 1);
  });
});
