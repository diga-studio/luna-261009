import test from "node:test";
import assert from "node:assert";
import { ModelGateway } from "../src/gateway.js";
import type { TerminalReason } from "../src/types.js";
import { ControllableModel, VirtualTime, flushMicrotasks } from "./helpers.js";

const WAIT_TIMEOUT = 45_000;

function setup() {
  const time = new VirtualTime();
  const modelA = new ControllableModel("m-a", ["chat"]);
  const modelB = new ControllableModel("m-b", ["chat"]);
  const gateway = new ModelGateway({
    models: [modelA, modelB],
    clock: time,
    scheduler: time,
  });
  const results = new Map<string, TerminalReason>();
  const record = (id: string) => (r: TerminalReason) => {
    if (results.has(id)) throw new Error(`double settlement for ${id}`);
    results.set(id, r);
  };
  return { time, modelA, modelB, gateway, results, record };
}

function submitBusyPair(gateway: ModelGateway, record: (id: string) => (r: TerminalReason) => void): void {
  gateway.submit({ id: "r1", capability: "chat" }).then(record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }).then(record("r2"));
}

test("timeout callback first: migrated request expires at deadline and never executes", async () => {
  const { time, modelA, modelB, gateway, results, record } = setup();
  submitBusyPair(gateway, record);
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-a")?.waiting, ["r3"]);

  time.advanceTo(WAIT_TIMEOUT - 1);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-b")?.waiting, ["r3"]);

  time.advanceTo(WAIT_TIMEOUT);
  await flushMicrotasks();
  assert.deepEqual(results.get("r3"), { kind: "timedOut" });
  assert.equal(modelB.executeStarted, 1, "expired request must not start");

  modelB.lastCall().result.resolve("done-r2");
  await flushMicrotasks();
  assert.equal(modelB.executeStarted, 1, "no queued request remains to start");
  assert.deepEqual(results.get("r2"), { kind: "completed", value: "done-r2" });
});

test("completion callback first: slot frees at deadline but expired waiter still never executes", async () => {
  const { time, modelA, modelB, gateway, results, record } = setup();
  submitBusyPair(gateway, record);
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));

  time.advanceTo(WAIT_TIMEOUT - 1);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-b")?.waiting, ["r3"]);

  time.setNow(WAIT_TIMEOUT);
  modelB.lastCall().result.resolve("done-r2");
  await flushMicrotasks();
  assert.deepEqual(results.get("r2"), { kind: "completed", value: "done-r2" });
  assert.deepEqual(results.get("r3"), { kind: "timedOut" });
  assert.equal(modelB.executeStarted, 1, "request at its deadline must not start");

  time.advanceBy(1);
  await flushMicrotasks();
  assert.equal(modelB.executeStarted, 1, "late timer must not revive the request");
  assert.equal(modelA.executeStarted + modelB.executeStarted, 2);
});

test("request started before deadline is not affected by wait timeout", async () => {
  const { time, modelA, modelB, gateway, results, record } = setup();
  submitBusyPair(gateway, record);
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));

  time.advanceTo(WAIT_TIMEOUT - 1);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);

  modelB.lastCall().result.resolve("done-r2");
  await flushMicrotasks();
  assert.equal(modelB.executeStarted, 2, "r3 starts just before its deadline");
  assert.equal(modelB.lastCall().request.id, "r3");

  time.advanceBy(10_000);
  await flushMicrotasks();
  assert.equal(results.has("r3"), false, "running request ignores wait timeout");

  modelB.lastCall().result.resolve("done-r3");
  await flushMicrotasks();
  assert.deepEqual(results.get("r3"), { kind: "completed", value: "done-r3" });
});

test("waiting request times out exactly at 45s without migration", async () => {
  const { time, modelA, gateway, results, record } = setup();
  gateway.submit({ id: "r1", capability: "chat" }).then(record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }).then(record("r2"));
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-a")?.waiting, ["r3"]);

  time.advanceTo(WAIT_TIMEOUT - 1);
  await flushMicrotasks();
  assert.equal(results.has("r3"), false);
  time.advanceTo(WAIT_TIMEOUT);
  await flushMicrotasks();
  assert.deepEqual(results.get("r3"), { kind: "timedOut" });
  assert.equal(modelA.executeStarted, 1);
});
