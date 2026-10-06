"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const localPulse_1 = require("../src/localPulse");
const helpers_1 = require("./helpers");
function ready(report) {
    strict_1.default.equal(report.status, "ready");
    return report;
}
(0, node_test_1.default)("interleaved completions never publish partial, mixed, or stale reports", async () => {
    const gate = new helpers_1.ScoreGate();
    const pulse = new localPulse_1.LocalPulse({ scoreFn: gate.fn });
    const c1 = (0, helpers_1.makeProfile)("c1");
    const a1 = (0, helpers_1.makeProfile)("a1");
    const b1 = (0, helpers_1.makeProfile)("b1");
    const c2 = (0, helpers_1.makeProfile)("c2");
    const a2 = (0, helpers_1.makeProfile)("a2");
    strict_1.default.equal(pulse.putCanonical("loc", c1), 1);
    strict_1.default.equal(pulse.putListing("loc", "dirA", a1), 2);
    strict_1.default.equal(pulse.putListing("loc", "dirB", b1), 3);
    // The rev2 pass (dirA only) is in flight; rev3 has not started a new pass.
    strict_1.default.equal(gate.calls.length, 1);
    gate.releaseMatching((i) => i.revision === 2);
    await (0, helpers_1.flushMicrotasks)();
    // The stale rev2 result is discarded and a pass for rev3 starts (dirA, dirB).
    strict_1.default.equal(gate.calls.length, 3);
    const rev3Calls = gate.calls.slice(1);
    strict_1.default.deepEqual(rev3Calls.map((c) => c.directory).sort(), ["dirA", "dirB"]);
    strict_1.default.ok(rev3Calls.every((c) => c.revision === 3));
    strict_1.default.equal(pulse.getReport("loc").status, "pending");
    // dirA of rev3 completes; dirB stays paused. Report must stay pending.
    gate.releaseMatching((i) => i.revision === 3 && i.directory === "dirA");
    await (0, helpers_1.flushMicrotasks)();
    let report = pulse.getReport("loc");
    strict_1.default.equal(report.status, "pending");
    strict_1.default.equal(report.revision, 3);
    // Writes invalidate the in-flight pass before it finishes.
    strict_1.default.equal(pulse.putCanonical("loc", c2), 4);
    strict_1.default.equal(pulse.putListing("loc", "dirA", a2), 5);
    report = pulse.getReport("loc");
    strict_1.default.equal(report.status, "pending");
    strict_1.default.equal(report.revision, 5);
    // The stale dirB scoring from rev3 finishes now: must not publish or corrupt.
    gate.releaseMatching((i) => i.revision === 3 && i.directory === "dirB");
    await (0, helpers_1.flushMicrotasks)();
    report = pulse.getReport("loc");
    strict_1.default.equal(report.status, "pending");
    strict_1.default.equal(report.revision, 5);
    // A fresh pass for rev5 has been scheduled with the latest snapshots.
    strict_1.default.equal(gate.calls.length, 5);
    const rev5Calls = gate.calls.slice(3);
    strict_1.default.ok(rev5Calls.every((c) => c.revision === 5));
    for (const call of rev5Calls) {
        strict_1.default.equal(call.canonical.businessName, "name-c2");
    }
    const rev5A = rev5Calls.find((c) => c.directory === "dirA");
    const rev5B = rev5Calls.find((c) => c.directory === "dirB");
    strict_1.default.equal(rev5A.listing.businessName, "name-a2");
    strict_1.default.equal(rev5B.listing.businessName, "name-b1");
    // Complete only one of the rev5 scorings: still pending, no partial report.
    gate.releaseMatching((i) => i.revision === 5 && i.directory === "dirA");
    await (0, helpers_1.flushMicrotasks)();
    report = pulse.getReport("loc");
    strict_1.default.equal(report.status, "pending");
    // Complete the last one: the ready report appears atomically.
    gate.releaseMatching((i) => i.revision === 5 && i.directory === "dirB");
    await (0, helpers_1.flushMicrotasks)();
    const final = ready(pulse.getReport("loc"));
    strict_1.default.equal(final.revision, 5);
    strict_1.default.equal(final.canonical.businessName, "name-c2");
    strict_1.default.equal(final.listings.dirA.businessName, "name-a2");
    strict_1.default.equal(final.listings.dirB.businessName, "name-b1");
    strict_1.default.deepEqual(final.directories.map((d) => d.directory).sort(), ["dirA", "dirB"]);
    for (const dir of final.directories) {
        strict_1.default.equal(dir.score, 0);
        strict_1.default.equal(dir.diffs.length, 4);
    }
    await pulse.whenIdle();
});
(0, node_test_1.default)("paused location does not block others; concurrency capped at 4", async () => {
    const gate = new helpers_1.ScoreGate();
    const pulse = new localPulse_1.LocalPulse({ scoreFn: gate.fn });
    // Location A: scoring started but paused (never released until the end).
    pulse.putCanonical("A", (0, helpers_1.makeProfile)("A-c"));
    pulse.putListing("A", "dirA", (0, helpers_1.makeProfile)("A-x"));
    strict_1.default.equal(gate.inFlight, 1);
    strict_1.default.equal(pulse.getReport("A").status, "pending");
    // Location B publishes independently while A is paused.
    pulse.putCanonical("B", (0, helpers_1.makeProfile)("B-c"));
    pulse.putListing("B", "dirB", (0, helpers_1.makeProfile)("B-c")); // identical -> score 100
    gate.releaseMatching((i) => i.locationId === "B");
    await (0, helpers_1.flushMicrotasks)();
    const reportB = ready(pulse.getReport("B"));
    strict_1.default.equal(reportB.revision, 2);
    strict_1.default.equal(reportB.directories.length, 1);
    strict_1.default.equal(reportB.directories[0].score, 100);
    strict_1.default.equal(reportB.directories[0].diffs.length, 0);
    strict_1.default.equal(pulse.getReport("A").status, "pending");
    // Writes and reads still work while A's scoring occupies one slot.
    strict_1.default.equal(pulse.putListing("A", "dirA", (0, helpers_1.makeProfile)("A-y")), 3);
    strict_1.default.equal(pulse.getReport("A").revision, 3);
    // Six more locations with one listing each: 6 queued tasks, 3 free slots.
    for (let n = 0; n < 6; n += 1) {
        const loc = `L${n}`;
        pulse.putCanonical(loc, (0, helpers_1.makeProfile)(`${loc}-c`));
        pulse.putListing(loc, "dir", (0, helpers_1.makeProfile)(`${loc}-l`));
    }
    await (0, helpers_1.flushMicrotasks)();
    strict_1.default.ok(gate.inFlight <= 4, `in-flight ${gate.inFlight} exceeds cap`);
    strict_1.default.equal(gate.maxInFlight, 4);
    // Drain everything; the cap is never exceeded at any point.
    await gate.releaseAll();
    await (0, helpers_1.flushMicrotasks)();
    await gate.releaseAll();
    await (0, helpers_1.flushMicrotasks)();
    strict_1.default.ok(gate.maxInFlight <= 4);
    await pulse.whenIdle();
    for (let n = 0; n < 6; n += 1) {
        strict_1.default.equal(pulse.getReport(`L${n}`).status, "ready");
    }
    const reportA = ready(pulse.getReport("A"));
    strict_1.default.equal(reportA.revision, 3);
    strict_1.default.equal(reportA.listings.dirA.businessName, "name-A-y");
});
(0, node_test_1.default)("10000 overwrites while paused only rescore the latest revision", async () => {
    const gate = new helpers_1.ScoreGate();
    const pulse = new localPulse_1.LocalPulse({ scoreFn: gate.fn });
    const canonical = (0, helpers_1.makeProfile)("canon");
    pulse.putCanonical("loc", canonical);
    pulse.putListing("loc", "dir", (0, helpers_1.makeProfile)("v0"));
    // One scoring call is now in flight and paused.
    strict_1.default.equal(gate.calls.length, 1);
    // 10000 overwrites while scoring is paused.
    for (let i = 1; i <= 10000; i += 1) {
        if (i % 2 === 0) {
            pulse.putCanonical("loc", (0, helpers_1.makeProfile)(`canon-${i}`));
        }
        else {
            pulse.putListing("loc", "dir", (0, helpers_1.makeProfile)(`v${i}`));
        }
    }
    strict_1.default.equal(pulse.getReport("loc").revision, 10002);
    strict_1.default.equal(pulse.getReport("loc").status, "pending");
    // Still only the original in-flight call; history is not re-executed.
    strict_1.default.equal(gate.calls.length, 1);
    // Mutating caller-side objects after the writes must not leak inside.
    canonical.businessName = "MUTATED";
    canonical.hours[0] = "MUTATED";
    // Resume: stale call finishes, exactly one catch-up pass runs.
    await gate.releaseAll();
    await (0, helpers_1.flushMicrotasks)();
    await gate.releaseAll();
    await (0, helpers_1.flushMicrotasks)();
    await pulse.whenIdle();
    strict_1.default.ok(gate.calls.length <= 3, `expected <=3 scoring calls, got ${gate.calls.length}`);
    const lastCall = gate.calls[gate.calls.length - 1];
    strict_1.default.equal(lastCall.revision, 10002);
    const report = ready(pulse.getReport("loc"));
    strict_1.default.equal(report.revision, 10002);
    strict_1.default.equal(report.canonical.businessName, "name-canon-10000");
    strict_1.default.equal(report.listings.dir.businessName, "name-v9999");
    strict_1.default.equal(report.directories.length, 1);
    strict_1.default.equal(report.directories[0].score, 0);
    strict_1.default.equal(report.directories[0].diffs.length, 4);
    const hoursDiff = report.directories[0].diffs.find((d) => d.field === "hours");
    strict_1.default.deepEqual(hoursDiff.canonical, Array.from({ length: 7 }, (_, i) => `h${i}-canon-10000`));
    strict_1.default.deepEqual(hoursDiff.listing, Array.from({ length: 7 }, (_, i) => `h${i}-v9999`));
    // Mutating the returned report must not affect internal state.
    report.canonical.businessName = "HACKED";
    report.listings.dir.hours[0] = "HACKED";
    report.directories[0].score = 100;
    report.directories[0].diffs.length = 0;
    const again = ready(pulse.getReport("loc"));
    strict_1.default.equal(again.canonical.businessName, "name-canon-10000");
    strict_1.default.equal(again.listings.dir.hours[0], "h0-v9999");
    strict_1.default.equal(again.directories[0].score, 0);
    strict_1.default.equal(again.directories[0].diffs.length, 4);
});
(0, node_test_1.default)("default scorer: field equality, hours array compare, empty directories", async () => {
    const pulse = new localPulse_1.LocalPulse();
    // No directories: ready immediately with an empty directory set.
    pulse.putCanonical("empty", (0, helpers_1.makeProfile)("e"));
    const emptyReport = ready(pulse.getReport("empty"));
    strict_1.default.equal(emptyReport.revision, 1);
    strict_1.default.deepEqual(emptyReport.directories, []);
    const canonical = (0, helpers_1.makeProfile)("c");
    const same = (0, helpers_1.makeProfile)("c");
    const listing = (0, helpers_1.makeProfile)("l");
    listing.businessName = canonical.businessName; // only address/phone/hours differ
    pulse.putCanonical("loc", canonical);
    pulse.putListing("loc", "same", same);
    pulse.putListing("loc", "diff", listing);
    await pulse.whenIdle();
    const report = ready(pulse.getReport("loc"));
    strict_1.default.equal(report.revision, 3);
    const sameResult = report.directories.find((d) => d.directory === "same");
    strict_1.default.equal(sameResult.score, 100);
    strict_1.default.deepEqual(sameResult.diffs, []);
    const diffResult = report.directories.find((d) => d.directory === "diff");
    strict_1.default.equal(diffResult.score, 25);
    strict_1.default.deepEqual(diffResult.diffs.map((d) => d.field), ["address", "phone", "hours"]);
    const addressDiff = diffResult.diffs.find((d) => d.field === "address");
    strict_1.default.equal(addressDiff.canonical, "addr-c");
    strict_1.default.equal(addressDiff.listing, "addr-l");
});
