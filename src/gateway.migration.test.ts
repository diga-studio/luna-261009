import test from "node:test";
import assert from "node:assert/strict";
import { InferenceGateway } from "./gateway.js";
import { FakeScheduler, ManualExecute, flushMicrotasks } from "./testkit.js";
import type { ModelDefinition, Outcome } from "./types.js";

function chatModel(id: string, manual: ManualExecute): ModelDefinition {
  return { id, capabilities: ["chat"], execute: manual.execute };
}

test("degradation migrates waiting requests preserving first-submit order", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const e2 = new ManualExecute();
  const gateway = new InferenceGateway(
    [chatModel("m1", e1), chatModel("m2", e2)],
    scheduler,
  );

  const outcomes = new Map<string, Promise<Outcome>>();
  const submit = (id: string) => {
    const p = gateway.submit({ id, capability: "chat" });
    outcomes.set(id, p);
    return p;
  };

  submit("r0"); // runs on m1
  submit("r1"); // runs on m2
  submit("r2"); // tie -> m1 waiting
  submit("r3"); // m2 waiting

  assert.equal(e1.callCount, 1);
  assert.equal(e2.callCount, 1);
  assert.deepEqual(
    gateway.snapshot().map((s) => [s.modelId, s.running, s.waiting]),
    [
      ["m1", "r0", ["r2"]],
      ["m2", "r1", ["r3"]],
    ],
  );

  gateway.reportHealth("m1", false);
  gateway.reportHealth("m1", false);
  assert.equal(gateway.snapshot()[0].healthy, true);
  assert.deepEqual(gateway.snapshot()[0].waiting, ["r2"]);

  gateway.reportHealth("m1", false); // third failure -> degraded
  const snap = gateway.snapshot();
  assert.equal(snap[0].healthy, false);
  assert.equal(snap[0].running, "r0"); // running request untouched
  assert.deepEqual(snap[0].waiting, []);
  assert.deepEqual(snap[1].waiting, ["r2", "r3"]); // merged by first-submit order

  // m2 finishes r1 -> r2 (migrated, earlier) must start next
  e2.resolve(0, "done-r1");
  await flushMicrotasks();
  assert.equal(e2.callCount, 2);
  assert.equal(e2.calls[1].id, "r2");

  e2.resolve(1, "done-r2");
  await flushMicrotasks();
  assert.equal(e2.calls[2].id, "r3");

  const r2Outcome = await outcomes.get("r2")!;
  assert.deepEqual(r2Outcome, { status: "completed", value: "done-r2" });
});

test("overflow beyond 20 waiting slots is rejected, not queued", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const e2 = new ManualExecute();
  const gateway = new InferenceGateway(
    [chatModel("a", e1), chatModel("b", e2)],
    scheduler,
  );

  const outcomes = new Map<string, Promise<Outcome>>();
  const submit = (id: string) => {
    const p = gateway.submit({ id, capability: "chat" });
    outcomes.set(id, p);
    return p;
  };

  submit("run-a"); // runs on a
  submit("run-b"); // runs on b
  const waiters: string[] = [];
  for (let i = 0; i < 39; i++) {
    const id = `w${i}`;
    waiters.push(id);
    submit(id);
  }

  // waiters alternate a,b,a,b... -> a has 20 (full), b has 19
  const before = gateway.snapshot();
  assert.equal(before[0].waiting.length, 20);
  assert.equal(before[1].waiting.length, 19);

  gateway.reportHealth("a", false);
  gateway.reportHealth("a", false);
  gateway.reportHealth("a", false);

  const after = gateway.snapshot();
  assert.equal(after[0].healthy, false);
  assert.deepEqual(after[0].waiting, []);
  // b had 19, only 1 free slot: earliest migrated waiter (w0) fits
  assert.equal(after[1].waiting.length, 20);
  const expectedOrder = ["w0", ...waiters.filter((_, i) => i % 2 === 1)];
  assert.deepEqual(after[1].waiting, expectedOrder);

  // the other 19 migrated waiters (w2, w4, ..., w38) are rejected
  const rejectedIds = waiters.filter((_, i) => i % 2 === 0 && i !== 0);
  assert.equal(rejectedIds.length, 19);
  for (const id of rejectedIds) {
    const outcome = await outcomes.get(id)!;
    assert.equal(outcome.status, "failed", id);
    assert.equal(outcome.status === "failed" && outcome.reason, "no-capacity", id);
  }

  // w0 was admitted to b's queue and is still pending
  let w0Settled = false;
  void outcomes.get("w0")!.then(() => {
    w0Settled = true;
  });
  await flushMicrotasks();
  assert.equal(w0Settled, false);

  // running requests on the degraded model are not cancelled
  assert.equal(after[0].running, "run-a");
});
