import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RetentionBonusLedger,
  VESTING_THRESHOLD_MS,
} from "../src/ledger";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const BONUS = 100_000;

test("out-of-order revisions: knownSeq prefix selects max revision, not arrival order", () => {
  const ledger = new RetentionBonusLedger();
  const at = T0 + 90 * DAY;

  // Larger revision arrives first: leaves exactly at the 90-day threshold -> vests.
  const r2 = ledger.recordEmployment("ref-a", 2, T0, T0 + 90 * DAY, BONUS);
  // Smaller revision arrives late: left on day 89 -> never vests.
  const r1 = ledger.recordEmployment("ref-a", 1, T0, T0 + 89 * DAY, BONUS);
  assert.ok(r1.seq > r2.seq);

  // Prefix containing nothing -> not found.
  const v0 = ledger.read("ref-a", at, r2.seq - 1);
  assert.equal(v0.exists, false);
  assert.equal(v0.status, "not_found");

  // Prefix with only rev2 -> vested (exactly at threshold counts).
  const v1 = ledger.read("ref-a", at, r2.seq);
  assert.equal(v1.status, "vested");
  assert.equal(v1.revision, 2);
  assert.equal(v1.vestedCents, BONUS);

  // Prefix with both -> still rev2 wins; late smaller revision must not override.
  const v2 = ledger.read("ref-a", at, r1.seq);
  assert.equal(v2.status, "vested");
  assert.equal(v2.revision, 2);
  assert.equal(v2.vestedCents, BONUS);
});

test("knownSeq change yields different historical views for same query time", () => {
  const ledger = new RetentionBonusLedger();
  const at = T0 + 90 * DAY;

  // Smaller revision first: left day 89 -> never vests.
  const r1 = ledger.recordEmployment("ref-b", 1, T0, T0 + 89 * DAY, BONUS);
  // Larger revision later: still employed -> vests at threshold.
  const r2 = ledger.recordEmployment("ref-b", 2, T0, null, BONUS);

  const v1 = ledger.read("ref-b", at, r1.seq);
  assert.equal(v1.status, "unvested");
  assert.equal(v1.revision, 1);
  assert.equal(v1.vestedCents, 0);

  const v2 = ledger.read("ref-b", at, r2.seq);
  assert.equal(v2.status, "vested");
  assert.equal(v2.revision, 2);
  assert.equal(v2.vestedCents, BONUS);
});

test("vesting boundary: exactly 90 days vests, one ms before does not", () => {
  const ledger = new RetentionBonusLedger();
  const rec = ledger.recordEmployment("ref-c", 1, T0, T0 + VESTING_THRESHOLD_MS, BONUS);

  const before = ledger.read("ref-c", T0 + VESTING_THRESHOLD_MS - 1, rec.seq);
  assert.equal(before.vestedCents, 0);
  assert.equal(before.status, "unvested");

  const exact = ledger.read("ref-c", T0 + VESTING_THRESHOLD_MS, rec.seq);
  assert.equal(exact.vestedCents, BONUS);
  assert.equal(exact.status, "vested");
});

test("leaving one day before threshold never vests", () => {
  const ledger = new RetentionBonusLedger();
  const rec = ledger.recordEmployment("ref-d", 1, T0, T0 + 89 * DAY, BONUS);
  const view = ledger.read("ref-d", T0 + 1000 * DAY, rec.seq);
  assert.equal(view.vestedCents, 0);
  assert.equal(view.status, "unvested");
});

test("duplicate employment fact returns original receipt without new seq", () => {
  const ledger = new RetentionBonusLedger();
  const a = ledger.recordEmployment("ref-e", 1, T0, null, BONUS);
  const b = ledger.recordEmployment("ref-e", 1, T0, null, BONUS);
  assert.deepEqual(b, a);
  const c = ledger.recordEmployment("ref-e", 2, T0, null, BONUS);
  assert.equal(c.seq, a.seq + 1);
});

test("approve requires vested bonus and binds the selected revision", () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment("ref-f", 1, T0, null, BONUS);

  const early = ledger.approve("cmd-f1", "ref-f", T0 + 89 * DAY);
  assert.equal(early.ok, false);

  const onTime = ledger.approve("cmd-f1", "ref-f", T0 + 90 * DAY);
  assert.equal(onTime.ok, true);
  if (onTime.ok) assert.equal(onTime.receipt.revision, 1);

  // Duplicate command returns the original receipt, no new seq.
  const dup = ledger.approve("cmd-f1", "ref-f", T0 + 90 * DAY);
  assert.deepEqual(dup, onTime);
});

test("late revision invalidates old approval; pay needs approval for current revision", () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment("ref-g", 1, T0, null, BONUS);
  const at = T0 + 90 * DAY;
  assert.equal(ledger.approve("cmd-g1", "ref-g", at).ok, true);

  // Correction arrives with a higher revision before payment.
  ledger.recordEmployment("ref-g", 2, T0, null, BONUS);
  const payStale = ledger.pay("cmd-g2", "ref-g", at + DAY);
  assert.equal(payStale.ok, false);

  // Re-approve on the new revision, then pay succeeds.
  assert.equal(ledger.approve("cmd-g3", "ref-g", at + DAY).ok, true);
  const paid = ledger.pay("cmd-g2", "ref-g", at + DAY);
  assert.equal(paid.ok, true);
  if (paid.ok) {
    assert.equal(paid.receipt.revision, 2);
    assert.equal(paid.receipt.amountCents, BONUS);
  }
});

test("pay after late day-89 revision: full clawback, then restored, never payable twice", () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment("ref-h", 1, T0, null, BONUS);
  const at = T0 + 90 * DAY;
  assert.equal(ledger.approve("cmd-h1", "ref-h", at).ok, true);
  const paid = ledger.pay("cmd-h2", "ref-h", at);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  const paySeq = paid.receipt.seq;

  // Late correction: actually left on day 89 -> full clawback in current view.
  ledger.recordEmployment("ref-h", 2, T0, T0 + 89 * DAY, BONUS);
  const clawed = ledger.read("ref-h", at, ledger.currentSeq);
  assert.equal(clawed.status, "paid");
  assert.equal(clawed.paidCents, BONUS);
  assert.equal(clawed.vestedCents, 0);
  assert.equal(clawed.clawbackCents, BONUS);

  // Historical view before the correction still shows the old vested state.
  const historical = ledger.read("ref-h", at, paySeq);
  assert.equal(historical.status, "paid");
  assert.equal(historical.vestedCents, BONUS);
  assert.equal(historical.clawbackCents, 0);

  // Another correction restores vesting -> clawback back to zero.
  ledger.recordEmployment("ref-h", 3, T0, null, BONUS);
  const restored = ledger.read("ref-h", at, ledger.currentSeq);
  assert.equal(restored.status, "paid");
  assert.equal(restored.vestedCents, BONUS);
  assert.equal(restored.clawbackCents, 0);

  // Retrying the same commandId returns the original receipt.
  const retry = ledger.pay("cmd-h2", "ref-h", at);
  assert.deepEqual(retry, paid);

  // A new commandId cannot pay a second bonus, even after re-approval.
  assert.equal(ledger.approve("cmd-h3", "ref-h", at).ok, true);
  const second = ledger.pay("cmd-h4", "ref-h", at);
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /already paid/);

  // The historical success receipt is not rewritten by corrections.
  const again = ledger.pay("cmd-h2", "ref-h", at);
  assert.equal(again.ok, true);
});

test("read filters approvals and payments by knownSeq and query time", () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment("ref-i", 1, T0, null, BONUS);
  const at = T0 + 90 * DAY;
  const approveRes = ledger.approve("cmd-i1", "ref-i", at);
  assert.equal(approveRes.ok, true);
  if (!approveRes.ok) return;
  const payRes = ledger.pay("cmd-i2", "ref-i", at + DAY);
  assert.equal(payRes.ok, true);
  if (!payRes.ok) return;

  const full = ledger.currentSeq;

  // Before approval seq: vested but not approved.
  const beforeApprove = ledger.read("ref-i", at + DAY, approveRes.receipt.seq - 1);
  assert.equal(beforeApprove.status, "vested");

  // Approval visible but payment seq excluded: approved.
  const afterApprove = ledger.read("ref-i", at + DAY, approveRes.receipt.seq);
  assert.equal(afterApprove.status, "approved");

  // Payment seq included but query time before payment.at: approved.
  const beforePayTime = ledger.read("ref-i", at, full);
  assert.equal(beforePayTime.status, "approved");

  // Payment visible: paid.
  const afterPay = ledger.read("ref-i", at + DAY, full);
  assert.equal(afterPay.status, "paid");
  assert.equal(afterPay.paidCents, BONUS);
});

test("command timestamps must be non-decreasing per referral", () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment("ref-j", 1, T0, null, BONUS);
  const at = T0 + 90 * DAY;
  assert.equal(ledger.approve("cmd-j1", "ref-j", at).ok, true);
  const backwards = ledger.pay("cmd-j2", "ref-j", at - 1);
  assert.equal(backwards.ok, false);
});
