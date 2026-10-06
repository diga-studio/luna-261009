import test from "node:test";
import assert from "node:assert/strict";
import { InferenceGateway } from "./gateway.js";
import { FakeScheduler, ManualExecute, flushMicrotasks } from "./testkit.js";
import type { ModelDefinition } from "./types.js";

function chatModel(id: string, manual: ManualExecute): ModelDefinition {
  return { id, capabilities: ["chat"], execute: manual.execute };
}

test("cancelling a running request does not free the slot early", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const e2 = new ManualExecute();
  const gateway = new InferenceGateway(
    [chatModel("m1", e1), chatModel("m2", e2)],
    scheduler,
  );

  const cancelSlow = new AbortController();
  const slowOutcome = gateway.submit(
    { id: "slow", capability: "chat" },
    cancelSlow.signal,
  );
  const otherOutcome = gateway.submit({ id: "other", capability: "chat" });
  const nextOutcome = gateway.submit({ id: "next", capability: "chat" });

  assert.equal(e1.callCount, 1); // slow runs on m1
  assert.equal(e2.callCount, 1); // other runs on m2
  assert.deepEqual(gateway.snapshot()[0].waiting, ["next"]);

  // cancel the running request: caller settles now, execute is signalled,
  // but the slot stays occupied because execute has not returned
  cancelSlow.abort();
  assert.deepEqual(await slowOutcome, { status: "failed", reason: "cancelled" });
  assert.equal(e1.signals[0].aborted, true);
  await flushMicrotasks();
  assert.equal(e1.callCount, 1); // next must NOT start early
  assert.equal(gateway.snapshot()[0].running, "slow");

  // the other model is unaffected and keeps executing
  e2.resolve(0, "other-done");
  await flushMicrotasks();
  assert.deepEqual(await otherOutcome, { status: "completed", value: "other-done" });
  const other2Outcome = gateway.submit({ id: "other2", capability: "chat" });
  assert.equal(e2.callCount, 2);
  assert.equal(e2.calls[1].id, "other2");

  // the stale execute finally returns: slot released exactly once,
  // the queued request starts exactly once
  e1.resolve(0, "slow-late-result");
  await flushMicrotasks();
  assert.equal(e1.callCount, 2);
  assert.equal(e1.calls[1].id, "next");
  assert.equal(gateway.snapshot()[0].running, "next");

  e1.resolve(1, "next-done");
  e2.resolve(1, "other2-done");
  await flushMicrotasks();
  assert.deepEqual(await nextOutcome, { status: "completed", value: "next-done" });
  assert.deepEqual(await other2Outcome, { status: "completed", value: "other2-done" });
  assert.equal(e1.callCount, 2);
  assert.equal(gateway.snapshot()[0].running, null);
});

test("cancelling a waiting request removes it before execution", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const gateway = new InferenceGateway([chatModel("m1", e1)], scheduler);

  const cancelWaiting = new AbortController();
  void gateway.submit({ id: "run", capability: "chat" });
  const waitingOutcome = gateway.submit(
    { id: "w", capability: "chat" },
    cancelWaiting.signal,
  );

  cancelWaiting.abort();
  assert.deepEqual(await waitingOutcome, { status: "failed", reason: "cancelled" });
  assert.deepEqual(gateway.snapshot()[0].waiting, []);

  e1.resolve(0, "run-done");
  await flushMicrotasks();
  assert.equal(e1.callCount, 1); // w never executed
});

test("synchronous execute throw releases the slot", async () => {
  const scheduler = new FakeScheduler();
  let calls = 0;
  const throwing: ModelDefinition = {
    id: "m1",
    capabilities: ["chat"],
    execute: () => {
      calls += 1;
      throw new Error("boom");
    },
  };
  const e2 = new ManualExecute();
  const gateway = new InferenceGateway([throwing, chatModel("m2", e2)], scheduler);

  const failed = gateway.submit({ id: "x", capability: "chat" });
  await flushMicrotasks();
  const outcome = await failed;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.status === "failed" && outcome.reason, "execute-error");
  assert.equal(gateway.snapshot()[0].running, null); // slot freed

  // m1 still healthy: a follow-up request may be dispatched again
  const again = gateway.submit({ id: "y", capability: "chat" });
  await flushMicrotasks();
  assert.equal(calls, 2);
  assert.equal((await again).status, "failed");
  assert.equal(gateway.snapshot()[0].running, null);
});
