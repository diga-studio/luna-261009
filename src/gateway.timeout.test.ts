import test from "node:test";
import assert from "node:assert/strict";
import { InferenceGateway, WAIT_TIMEOUT_MS } from "./gateway.js";
import { FakeScheduler, ManualExecute, flushMicrotasks } from "./testkit.js";
import type { ModelDefinition, Outcome } from "./types.js";

function chatModel(id: string, manual: ManualExecute): ModelDefinition {
  return { id, capabilities: ["chat"], execute: manual.execute };
}

interface Setup {
  scheduler: FakeScheduler;
  gateway: InferenceGateway;
  e1: ManualExecute;
  e2: ManualExecute;
  wOutcome: Promise<Outcome>;
}

function setupMigratedNearDeadline(): Setup {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const e2 = new ManualExecute();
  const gateway = new InferenceGateway(
    [chatModel("m1", e1), chatModel("m2", e2)],
    scheduler,
  );

  void gateway.submit({ id: "run1", capability: "chat" }); // runs on m1
  void gateway.submit({ id: "run2", capability: "chat" }); // runs on m2
  const wOutcome = gateway.submit({ id: "w", capability: "chat" }); // waits on m1

  // migrate at t = 45s - 10ms; the 45s deadline must NOT refresh
  scheduler.advanceBy(WAIT_TIMEOUT_MS - 10);
  gateway.reportHealth("m1", false);
  gateway.reportHealth("m1", false);
  gateway.reportHealth("m1", false);
  assert.deepEqual(gateway.snapshot()[1].waiting, ["w"]);

  return { scheduler, gateway, e1, e2, wOutcome };
}

test("completion callback first at deadline: expired request never executes", async () => {
  const { scheduler, gateway, e2, wOutcome } = setupMigratedNearDeadline();

  // clock reaches the deadline, but the timeout callback has not run yet
  scheduler.setTime(WAIT_TIMEOUT_MS);
  // the running execute on m2 completes first
  e2.resolve(0, "run2-done");
  await flushMicrotasks();

  // w must have been timed out by the pump guard, not executed
  assert.equal(e2.callCount, 1);
  assert.deepEqual(await wOutcome, { status: "failed", reason: "timeout" });

  // the late timeout callback is a no-op
  scheduler.runDue();
  await flushMicrotasks();
  assert.equal(e2.callCount, 1);
  assert.deepEqual(gateway.snapshot()[1].waiting, []);
  assert.equal(gateway.snapshot()[1].running, null);
});

test("timeout callback first at deadline: late completion does not revive", async () => {
  const { scheduler, gateway, e2, wOutcome } = setupMigratedNearDeadline();

  scheduler.setTime(WAIT_TIMEOUT_MS);
  scheduler.runDue(); // timeout callback fires first
  assert.deepEqual(await wOutcome, { status: "failed", reason: "timeout" });

  // the running execute completes afterwards; nothing left to dispatch
  e2.resolve(0, "run2-done");
  await flushMicrotasks();
  assert.equal(e2.callCount, 1);
  assert.equal(gateway.snapshot()[1].running, null);
  assert.deepEqual(gateway.snapshot()[1].waiting, []);
});

test("migrated request executed before deadline is unaffected by wait timeout", async () => {
  const { scheduler, e2, wOutcome } = setupMigratedNearDeadline();

  // m2 frees up 5ms before the deadline -> w starts executing
  scheduler.advanceBy(5);
  e2.resolve(0, "run2-done");
  await flushMicrotasks();
  assert.equal(e2.callCount, 2);
  assert.equal(e2.calls[1].id, "w");

  // crossing the original deadline must not disturb a running request
  scheduler.advanceBy(WAIT_TIMEOUT_MS);
  await flushMicrotasks();
  e2.resolve(1, "w-done");
  await flushMicrotasks();
  assert.deepEqual(await wOutcome, { status: "completed", value: "w-done" });
});
