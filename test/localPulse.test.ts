import assert from "node:assert/strict";
import test from "node:test";
import { LocalPulse } from "../src/localPulse";
import { ReadyReport } from "../src/types";
import { ScoreGate, flushMicrotasks, makeProfile } from "./helpers";

function ready(report: ReturnType<LocalPulse["getReport"]>): ReadyReport {
  assert.equal(report.status, "ready");
  return report as ReadyReport;
}

test("interleaved completions never publish partial, mixed, or stale reports", async () => {
  const gate = new ScoreGate();
  const pulse = new LocalPulse({ scoreFn: gate.fn });

  const c1 = makeProfile("c1");
  const a1 = makeProfile("a1");
  const b1 = makeProfile("b1");
  const c2 = makeProfile("c2");
  const a2 = makeProfile("a2");

  assert.equal(pulse.putCanonical("loc", c1), 1);
  assert.equal(pulse.putListing("loc", "dirA", a1), 2);
  assert.equal(pulse.putListing("loc", "dirB", b1), 3);

  // The rev2 pass (dirA only) is in flight; rev3 has not started a new pass.
  assert.equal(gate.calls.length, 1);
  gate.releaseMatching((i) => i.revision === 2);
  await flushMicrotasks();

  // The stale rev2 result is discarded and a pass for rev3 starts (dirA, dirB).
  assert.equal(gate.calls.length, 3);
  const rev3Calls = gate.calls.slice(1);
  assert.deepEqual(rev3Calls.map((c) => c.directory).sort(), ["dirA", "dirB"]);
  assert.ok(rev3Calls.every((c) => c.revision === 3));
  assert.equal(pulse.getReport("loc").status, "pending");

  // dirA of rev3 completes; dirB stays paused. Report must stay pending.
  gate.releaseMatching((i) => i.revision === 3 && i.directory === "dirA");
  await flushMicrotasks();
  let report = pulse.getReport("loc");
  assert.equal(report.status, "pending");
  assert.equal(report.revision, 3);

  // Writes invalidate the in-flight pass before it finishes.
  assert.equal(pulse.putCanonical("loc", c2), 4);
  assert.equal(pulse.putListing("loc", "dirA", a2), 5);
  report = pulse.getReport("loc");
  assert.equal(report.status, "pending");
  assert.equal(report.revision, 5);

  // The stale dirB scoring from rev3 finishes now: must not publish or corrupt.
  gate.releaseMatching((i) => i.revision === 3 && i.directory === "dirB");
  await flushMicrotasks();
  report = pulse.getReport("loc");
  assert.equal(report.status, "pending");
  assert.equal(report.revision, 5);

  // A fresh pass for rev5 has been scheduled with the latest snapshots.
  assert.equal(gate.calls.length, 5);
  const rev5Calls = gate.calls.slice(3);
  assert.ok(rev5Calls.every((c) => c.revision === 5));
  for (const call of rev5Calls) {
    assert.equal(call.canonical.businessName, "name-c2");
  }
  const rev5A = rev5Calls.find((c) => c.directory === "dirA")!;
  const rev5B = rev5Calls.find((c) => c.directory === "dirB")!;
  assert.equal(rev5A.listing.businessName, "name-a2");
  assert.equal(rev5B.listing.businessName, "name-b1");

  // Complete only one of the rev5 scorings: still pending, no partial report.
  gate.releaseMatching((i) => i.revision === 5 && i.directory === "dirA");
  await flushMicrotasks();
  report = pulse.getReport("loc");
  assert.equal(report.status, "pending");

  // Complete the last one: the ready report appears atomically.
  gate.releaseMatching((i) => i.revision === 5 && i.directory === "dirB");
  await flushMicrotasks();
  const final = ready(pulse.getReport("loc"));
  assert.equal(final.revision, 5);
  assert.equal(final.canonical.businessName, "name-c2");
  assert.equal(final.listings.dirA.businessName, "name-a2");
  assert.equal(final.listings.dirB.businessName, "name-b1");
  assert.deepEqual(
    final.directories.map((d) => d.directory).sort(),
    ["dirA", "dirB"],
  );
  for (const dir of final.directories) {
    assert.equal(dir.score, 0);
    assert.equal(dir.diffs.length, 4);
  }

  await pulse.whenIdle();
});

test("paused location does not block others; concurrency capped at 4", async () => {
  const gate = new ScoreGate();
  const pulse = new LocalPulse({ scoreFn: gate.fn });

  // Location A: scoring started but paused (never released until the end).
  pulse.putCanonical("A", makeProfile("A-c"));
  pulse.putListing("A", "dirA", makeProfile("A-x"));
  assert.equal(gate.inFlight, 1);
  assert.equal(pulse.getReport("A").status, "pending");

  // Location B publishes independently while A is paused.
  pulse.putCanonical("B", makeProfile("B-c"));
  pulse.putListing("B", "dirB", makeProfile("B-c")); // identical -> score 100
  gate.releaseMatching((i) => i.locationId === "B");
  await flushMicrotasks();
  const reportB = ready(pulse.getReport("B"));
  assert.equal(reportB.revision, 2);
  assert.equal(reportB.directories.length, 1);
  assert.equal(reportB.directories[0].score, 100);
  assert.equal(reportB.directories[0].diffs.length, 0);
  assert.equal(pulse.getReport("A").status, "pending");

  // Writes and reads still work while A's scoring occupies one slot.
  assert.equal(pulse.putListing("A", "dirA", makeProfile("A-y")), 3);
  assert.equal(pulse.getReport("A").revision, 3);

  // Six more locations with one listing each: 6 queued tasks, 3 free slots.
  for (let n = 0; n < 6; n += 1) {
    const loc = `L${n}`;
    pulse.putCanonical(loc, makeProfile(`${loc}-c`));
    pulse.putListing(loc, "dir", makeProfile(`${loc}-l`));
  }
  await flushMicrotasks();
  assert.ok(gate.inFlight <= 4, `in-flight ${gate.inFlight} exceeds cap`);
  assert.equal(gate.maxInFlight, 4);

  // Drain everything; the cap is never exceeded at any point.
  await gate.releaseAll();
  await flushMicrotasks();
  await gate.releaseAll();
  await flushMicrotasks();
  assert.ok(gate.maxInFlight <= 4);

  await pulse.whenIdle();
  for (let n = 0; n < 6; n += 1) {
    assert.equal(pulse.getReport(`L${n}`).status, "ready");
  }
  const reportA = ready(pulse.getReport("A"));
  assert.equal(reportA.revision, 3);
  assert.equal(reportA.listings.dirA.businessName, "name-A-y");
});

test("10000 overwrites while paused only rescore the latest revision", async () => {
  const gate = new ScoreGate();
  const pulse = new LocalPulse({ scoreFn: gate.fn });

  const canonical = makeProfile("canon");
  pulse.putCanonical("loc", canonical);
  pulse.putListing("loc", "dir", makeProfile("v0"));
  // One scoring call is now in flight and paused.
  assert.equal(gate.calls.length, 1);

  // 10000 overwrites while scoring is paused.
  for (let i = 1; i <= 10000; i += 1) {
    if (i % 2 === 0) {
      pulse.putCanonical("loc", makeProfile(`canon-${i}`));
    } else {
      pulse.putListing("loc", "dir", makeProfile(`v${i}`));
    }
  }
  assert.equal(pulse.getReport("loc").revision, 10002);
  assert.equal(pulse.getReport("loc").status, "pending");
  // Still only the original in-flight call; history is not re-executed.
  assert.equal(gate.calls.length, 1);

  // Mutating caller-side objects after the writes must not leak inside.
  canonical.businessName = "MUTATED";
  canonical.hours[0] = "MUTATED";

  // Resume: stale call finishes, exactly one catch-up pass runs.
  await gate.releaseAll();
  await flushMicrotasks();
  await gate.releaseAll();
  await flushMicrotasks();
  await pulse.whenIdle();

  assert.ok(gate.calls.length <= 3, `expected <=3 scoring calls, got ${gate.calls.length}`);
  const lastCall = gate.calls[gate.calls.length - 1];
  assert.equal(lastCall.revision, 10002);

  const report = ready(pulse.getReport("loc"));
  assert.equal(report.revision, 10002);
  assert.equal(report.canonical.businessName, "name-canon-10000");
  assert.equal(report.listings.dir.businessName, "name-v9999");
  assert.equal(report.directories.length, 1);
  assert.equal(report.directories[0].score, 0);
  assert.equal(report.directories[0].diffs.length, 4);
  const hoursDiff = report.directories[0].diffs.find((d) => d.field === "hours")!;
  assert.deepEqual(hoursDiff.canonical, Array.from({ length: 7 }, (_, i) => `h${i}-canon-10000`));
  assert.deepEqual(hoursDiff.listing, Array.from({ length: 7 }, (_, i) => `h${i}-v9999`));

  // Mutating the returned report must not affect internal state.
  report.canonical.businessName = "HACKED";
  report.listings.dir.hours[0] = "HACKED";
  report.directories[0].score = 100;
  report.directories[0].diffs.length = 0;
  const again = ready(pulse.getReport("loc"));
  assert.equal(again.canonical.businessName, "name-canon-10000");
  assert.equal(again.listings.dir.hours[0], "h0-v9999");
  assert.equal(again.directories[0].score, 0);
  assert.equal(again.directories[0].diffs.length, 4);
});

test("default scorer: field equality, hours array compare, empty directories", async () => {
  const pulse = new LocalPulse();

  // No directories: ready immediately with an empty directory set.
  pulse.putCanonical("empty", makeProfile("e"));
  const emptyReport = ready(pulse.getReport("empty"));
  assert.equal(emptyReport.revision, 1);
  assert.deepEqual(emptyReport.directories, []);

  const canonical = makeProfile("c");
  const same = makeProfile("c");
  const listing = makeProfile("l");
  listing.businessName = canonical.businessName; // only address/phone/hours differ
  pulse.putCanonical("loc", canonical);
  pulse.putListing("loc", "same", same);
  pulse.putListing("loc", "diff", listing);
  await pulse.whenIdle();

  const report = ready(pulse.getReport("loc"));
  assert.equal(report.revision, 3);
  const sameResult = report.directories.find((d) => d.directory === "same")!;
  assert.equal(sameResult.score, 100);
  assert.deepEqual(sameResult.diffs, []);
  const diffResult = report.directories.find((d) => d.directory === "diff")!;
  assert.equal(diffResult.score, 25);
  assert.deepEqual(
    diffResult.diffs.map((d) => d.field),
    ["address", "phone", "hours"],
  );
  const addressDiff = diffResult.diffs.find((d) => d.field === "address")!;
  assert.equal(addressDiff.canonical, "addr-c");
  assert.equal(addressDiff.listing, "addr-l");
});
