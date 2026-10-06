import { test } from 'node:test';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openDatabase, NotificationService } from '../src/index.js';
import type { CustomerState, Segment } from '../src/index.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000; // fixed logical epoch

function makeService() {
  const db = openDatabase(':memory:');
  return { db, svc: new NotificationService(db) };
}

function customer(
  customerId: string,
  overrides: Partial<Omit<CustomerState, 'customerId'>> = {},
): CustomerState {
  return {
    customerId,
    lastPurchaseAt: null,
    cartNonEmpty: false,
    cartUpdatedAt: null,
    ...overrides,
  };
}

function expectedRecipients(customers: CustomerState[], segment: Segment, t: number): string[] {
  return customers
    .filter((c) => {
      if (segment === 'all') return true;
      if (segment === 'recent_buyers') {
        return c.lastPurchaseAt !== null && c.lastPurchaseAt >= t - 30 * DAY && c.lastPurchaseAt <= t;
      }
      return c.cartNonEmpty && c.cartUpdatedAt !== null && t - c.cartUpdatedAt > 48 * HOUR;
    })
    .map((c) => c.customerId)
    .sort();
}

test('campaign stays scheduled before its planned time, then activates at t', () => {
  const { svc } = makeService();
  svc.upsertCustomer(customer('c1'), T0);
  svc.createCampaign(
    { id: 'camp1', title: 't', body: 'b', segment: 'all', scheduledAt: T0 + DAY },
    T0,
  );

  const early = svc.advance('camp1', T0 + DAY - 1, 10);
  assert.equal(early.status, 'scheduled');
  assert.equal(early.delivered, 0);
  assert.deepEqual(svc.getNotifications('c1', T0 + DAY - 1), []);

  const due = svc.advance('camp1', T0 + DAY, 10);
  assert.equal(due.status, 'sent');
  assert.equal(due.delivered, 1);
  const campaign = svc.getCampaign('camp1');
  assert.equal(campaign?.status, 'sent');
  assert.equal(campaign?.activatedAt, T0 + DAY);
  assert.equal(campaign?.expiresAt, T0 + DAY + 30 * DAY);
});

test('segment snapshots are frozen at activation despite later fact changes and new customers', () => {
  const { svc } = makeService();
  const t = T0 + 100 * DAY;
  const initial: CustomerState[] = [
    customer('all-1'),
    customer('recent-in-low', { lastPurchaseAt: t - 30 * DAY }), // closed interval lower bound
    customer('recent-in-high', { lastPurchaseAt: t }), // closed interval upper bound
    customer('recent-out-old', { lastPurchaseAt: t - 30 * DAY - 1 }),
    customer('recent-out-future', { lastPurchaseAt: t + 1 }),
    customer('stale-yes', { cartNonEmpty: true, cartUpdatedAt: t - 48 * HOUR - 1 }),
    customer('stale-boundary', { cartNonEmpty: true, cartUpdatedAt: t - 48 * HOUR }), // strict > fails
    customer('stale-empty-cart', { cartNonEmpty: false, cartUpdatedAt: t - 100 * DAY }),
  ];
  for (const c of initial) svc.upsertCustomer(c, T0);

  const segments: Segment[] = ['all', 'recent_buyers', 'stale_cart'];
  for (const segment of segments) {
    svc.createCampaign(
      { id: `camp-${segment}`, title: segment, body: 'b', segment, scheduledAt: t },
      T0,
    );
  }

  // Activate all campaigns and deliver only the first round (batchSize 2).
  for (const segment of segments) {
    const res = svc.advance(`camp-${segment}`, t, 2);
    assert.equal(res.delivered, Math.min(2, expectedRecipients(initial, segment, t).length));
  }

  // Mutate facts and add new customers between rounds.
  svc.upsertCustomer(customer('recent-in-low', { lastPurchaseAt: null }), t + HOUR);
  svc.upsertCustomer(customer('recent-out-old', { lastPurchaseAt: t }), t + HOUR);
  svc.upsertCustomer(customer('stale-boundary', { cartNonEmpty: true, cartUpdatedAt: t - 100 * DAY }), t + HOUR);
  svc.upsertCustomer(customer('stale-yes', { cartNonEmpty: false, cartUpdatedAt: null }), t + HOUR);
  svc.upsertCustomer(customer('newcomer', { lastPurchaseAt: t }), t + HOUR);

  // Finish all rounds.
  for (const segment of segments) {
    for (let i = 0; i < 20; i++) svc.advance(`camp-${segment}`, t + 2 * HOUR, 3);
  }

  for (const segment of segments) {
    const campaign = svc.getCampaign(`camp-${segment}`);
    assert.equal(campaign?.status, 'sent', segment);

    const expected = expectedRecipients(initial, segment, t);
    const counts = new Map<string, number>();
    for (const id of new Set([...expected, 'newcomer', 'recent-out-old', 'stale-boundary'])) {
      const notes = svc.getNotifications(id, t + 2 * HOUR).filter((n) => n.campaignId === `camp-${segment}`);
      counts.set(id, (counts.get(id) ?? 0) + notes.length);
    }
    const actual = [...counts.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort();
    assert.deepEqual(actual, expected, segment);
    for (const [, n] of counts) assert.ok(n <= 1, 'at most one notification per recipient');
  }
});

test('notifications expire 30 days after t, are purged in rounds, and campaign still completes', () => {
  const { db, svc } = makeService();
  const t = T0;
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
  for (const id of ids) svc.upsertCustomer(customer(id), t - DAY);
  svc.createCampaign({ id: 'camp', title: 't', body: 'b', segment: 'all', scheduledAt: t }, t - DAY);

  // Activate and deliver to 2 of 5 recipients.
  const first = svc.advance('camp', t, 2);
  assert.equal(first.delivered, 2);
  assert.equal(first.status, 'sending');

  // Delivered notifications are readable right away, before the campaign finishes.
  const visible = ids.map((id) => svc.getNotifications(id, t).length);
  assert.deepEqual(visible.filter((n) => n === 1).length, 2);

  // Notification expires exactly at t + 30 days: readable just before, not at the instant.
  const someDelivered = ids.find((id) => svc.getNotifications(id, t).length === 1)!;
  assert.equal(svc.getNotifications(someDelivered, t + 30 * DAY - 1).length, 1);
  assert.equal(svc.getNotifications(someDelivered, t + 30 * DAY).length, 0);

  // Cross the 30-day mark: advance purges expired notifications from storage
  // and completes remaining recipients as no-delivery.
  const after = svc.advance('camp', t + 30 * DAY + DAY, 5);
  assert.equal(after.delivered, 0);
  assert.equal(after.expiredNotifications, 2);
  assert.equal(after.expiredRecipients, 3);
  assert.equal(after.status, 'sent');

  // Expired notifications are gone from the persisted records (raw table check).
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE campaign_id = 'camp'")
    .get() as { n: number };
  assert.equal(Number(remaining.n), 0);
  for (const id of ids) {
    assert.deepEqual(svc.getNotifications(id, t + 30 * DAY + DAY), []);
  }

  // Repeated advances never create new notifications and never regress status.
  for (let round = 0; round < 3; round++) {
    const again = svc.advance('camp', t + 31 * DAY + round * DAY, 5);
    assert.equal(again.delivered, 0);
    assert.equal(again.expiredNotifications, 0);
    assert.equal(again.expiredRecipients, 0);
    assert.equal(again.status, 'sent');
  }
  assert.equal(svc.getCampaign('camp')?.status, 'sent');
});

test('delivery keeps original expiry and never resurrects expired notifications', () => {
  const { svc } = makeService();
  const t = T0;
  svc.upsertCustomer(customer('c1'), t - DAY);
  svc.upsertCustomer(customer('c2'), t - DAY);
  svc.createCampaign({ id: 'camp', title: 't', body: 'b', segment: 'all', scheduledAt: t }, t - DAY);

  svc.advance('camp', t, 1); // deliver to one recipient
  const [note] = svc.getNotifications('c1', t).concat(svc.getNotifications('c2', t));
  assert.equal(note.expiresAt, t + 30 * DAY);

  // Deliver the second recipient later; expiry stays anchored to t, not the delivery time.
  svc.advance('camp', t + 10 * DAY, 1);
  const later = svc.getNotifications('c1', t + 10 * DAY).concat(svc.getNotifications('c2', t + 10 * DAY));
  assert.equal(later.length, 2);
  for (const n of later) assert.equal(n.expiresAt, t + 30 * DAY);
});

test('logical time must be monotonically non-decreasing', () => {
  const { svc } = makeService();
  svc.upsertCustomer(customer('c1'), T0);
  assert.throws(() => svc.upsertCustomer(customer('c2'), T0 - 1), /monotonically/);
  svc.upsertCustomer(customer('c2'), T0); // equal is allowed
  assert.equal(svc.getCampaign('missing'), null);
});

test('facts, campaigns and notifications persist in a SQLite file across instances', () => {
  const path = `/tmp/campaign-lib-test-${process.pid}-${Date.now()}.sqlite`;
  const t = T0;

  const db1 = openDatabase(path);
  const svc1 = new NotificationService(db1);
  svc1.upsertCustomer(customer('c1', { lastPurchaseAt: t - DAY }), t - DAY);
  svc1.createCampaign({ id: 'camp', title: 't', body: 'b', segment: 'recent_buyers', scheduledAt: t }, t - DAY);
  svc1.advance('camp', t, 10);
  db1.close();

  const db2 = openDatabase(path);
  const svc2 = new NotificationService(db2);
  assert.equal(svc2.getCampaign('camp')?.status, 'sent');
  const notes = svc2.getNotifications('c1', t);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 't');
  db2.close();
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
});
