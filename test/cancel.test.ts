import test from "node:test";
import assert from "node:assert";
import { ModelGateway } from "../src/gateway.js";
import type { TerminalReason } from "../src/types.js";
import { ControllableModel, VirtualTime, flushMicrotasks } from "./helpers.js";

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

test("cancelling a running request settles the caller but holds the slot until execute returns", async () => {
  const { modelA, modelB, gateway, results, record } = setup();
  const abort1 = new AbortController();

  gateway.submit({ id: "r1", capability: "chat" }, abort1.signal).then(record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }).then(record("r2"));
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));
  assert.equal(modelA.executeStarted, 1);
  assert.equal(modelB.executeStarted, 1);
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-a")?.waiting, ["r3"]);

  abort1.abort();
  await flushMicrotasks();
  assert.deepEqual(results.get("r1"), { kind: "cancelled" });
  assert.equal(modelA.calls[0]?.signal.aborted, true, "execute is notified");
  assert.equal(
    gateway.snapshot().find((s) => s.id === "m-a")?.running,
    "r1",
    "slot stays occupied while execute is pending",
  );
  assert.equal(modelA.executeStarted, 1, "r3 must not start early");

  gateway.submit({ id: "r4", capability: "chat" }).then(record("r4"));
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-b")?.waiting, ["r4"]);

  modelB.lastCall().result.resolve("done-r2");
  await flushMicrotasks();
  assert.equal(modelB.executeStarted, 2, "other model keeps executing");
  assert.equal(modelB.lastCall().request.id, "r4");
  assert.equal(modelA.executeStarted, 1, "cancelled model slot still blocked");

  modelA.calls[0]?.result.resolve("late-r1");
  await flushMicrotasks();
  assert.equal(modelA.executeStarted, 2, "r3 starts once the slot truly frees");
  assert.equal(modelA.lastCall().request.id, "r3");
  assert.deepEqual(results.get("r1"), { kind: "cancelled" }, "late result does not re-settle");

  modelA.lastCall().result.resolve("done-r3");
  await flushMicrotasks();
  assert.deepEqual(results.get("r3"), { kind: "completed", value: "done-r3" });
  assert.equal(modelA.executeStarted, 2, "no request executes twice");
  assert.equal(gateway.snapshot().find((s) => s.id === "m-a")?.running, null);
});

test("cancelling a waiting request removes it so it never executes", async () => {
  const { modelA, gateway, results, record } = setup();
  const abort2 = new AbortController();

  gateway.submit({ id: "r1", capability: "chat" }).then(record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }, abort2.signal).then(record("r2"));
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));
  assert.deepEqual(gateway.snapshot().find((s) => s.id === "m-a")?.waiting, ["r3"]);

  abort2.abort();
  await flushMicrotasks();
  assert.deepEqual(results.get("r2"), { kind: "cancelled" });
  assert.equal(modelA.executeStarted + 1, 2);

  modelA.calls[0]?.result.resolve("done-r1");
  await flushMicrotasks();
  assert.equal(modelA.executeStarted, 2);
  assert.equal(modelA.lastCall().request.id, "r3");
});

test("submitting with an already-aborted signal cancels immediately without executing", async () => {
  const { modelA, gateway, results, record } = setup();
  const abort = new AbortController();
  abort.abort();
  gateway.submit({ id: "r1", capability: "chat" }, abort.signal).then(record("r1"));
  await flushMicrotasks();
  assert.deepEqual(results.get("r1"), { kind: "cancelled" });
  assert.equal(modelA.executeStarted, 0);
});

test("late execute rejection after cancel releases the slot exactly once", async () => {
  const { modelA, gateway, results, record } = setup();
  const abort1 = new AbortController();
  gateway.submit({ id: "r1", capability: "chat" }, abort1.signal).then(record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }).then(record("r2"));
  gateway.submit({ id: "r3", capability: "chat" }).then(record("r3"));

  abort1.abort();
  await flushMicrotasks();
  assert.deepEqual(results.get("r1"), { kind: "cancelled" });

  modelA.calls[0]?.result.reject(new Error("boom"));
  await flushMicrotasks();
  assert.equal(modelA.executeStarted, 2, "next queued request starts exactly once");
  assert.equal(modelA.lastCall().request.id, "r3");
  assert.deepEqual(results.get("r1"), { kind: "cancelled" });
});
