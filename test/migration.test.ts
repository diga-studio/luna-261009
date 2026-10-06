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
  return { time, modelA, modelB, gateway };
}

function resultsOf(): { map: Map<string, TerminalReason>; record(id: string): (r: TerminalReason) => void } {
  const map = new Map<string, TerminalReason>();
  return {
    map,
    record(id: string) {
      return (r: TerminalReason) => {
        if (map.has(id)) throw new Error(`double settlement for ${id}`);
        map.set(id, r);
      };
    },
  };
}

test("degradation migrates waiting requests keeping first-submit order; overflow is rejected", async () => {
  const { modelA, modelB, gateway } = setup();
  const results = resultsOf();

  gateway.submit({ id: "r1", capability: "chat" }).then(results.record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }).then(results.record("r2"));
  assert.equal(modelA.executeStarted, 1);
  assert.equal(modelB.executeStarted, 1);

  gateway.submit({ id: "r3", capability: "chat" }).then(results.record("r3"));
  gateway.submit({ id: "r4", capability: "chat" }).then(results.record("r4"));

  let snap = gateway.snapshot();
  assert.deepEqual(snap.find((s) => s.id === "m-a")?.waiting, ["r3"]);
  assert.deepEqual(snap.find((s) => s.id === "m-b")?.waiting, ["r4"]);

  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  assert.equal(gateway.snapshot().find((s) => s.id === "m-a")?.healthy, true);
  gateway.reportHealth("m-a", false);

  snap = gateway.snapshot();
  const a = snap.find((s) => s.id === "m-a");
  const b = snap.find((s) => s.id === "m-b");
  assert.equal(a?.healthy, false);
  assert.equal(a?.running, "r1", "running request is not cancelled by degradation");
  assert.deepEqual(a?.waiting, []);
  assert.deepEqual(b?.waiting, ["r3", "r4"], "merged queue keeps first-submit order");

  for (let i = 5; i <= 22; i += 1) {
    gateway.submit({ id: `r${i}`, capability: "chat" }).then(results.record(`r${i}`));
  }
  snap = gateway.snapshot();
  assert.equal(snap.find((s) => s.id === "m-b")?.waiting.length, 20);

  gateway.submit({ id: "r23", capability: "chat" }).then(results.record("r23"));
  await flushMicrotasks();
  assert.deepEqual(results.map.get("r23"), { kind: "rejected", reason: "no-capacity" });

  modelB.lastCall().result.resolve("done-r2");
  await flushMicrotasks();
  assert.deepEqual(results.map.get("r2"), { kind: "completed", value: "done-r2" });
  assert.equal(modelB.executeStarted, 2);
  assert.equal(modelB.lastCall().request.id, "r3", "oldest waiting request starts next");
  assert.deepEqual(
    gateway.snapshot().find((s) => s.id === "m-b")?.waiting[0],
    "r4",
  );
});

test("one success resets failure count and restores health", async () => {
  const { gateway } = setup();
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", true);
  gateway.reportHealth("m-a", false);
  gateway.reportHealth("m-a", false);
  assert.equal(gateway.snapshot().find((s) => s.id === "m-a")?.healthy, true);
  gateway.reportHealth("m-a", false);
  assert.equal(gateway.snapshot().find((s) => s.id === "m-a")?.healthy, false);
  gateway.reportHealth("m-a", true);
  assert.equal(gateway.snapshot().find((s) => s.id === "m-a")?.healthy, true);
});
