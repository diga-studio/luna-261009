import test from "node:test";
import assert from "node:assert";
import { ModelGateway } from "../src/gateway.js";
import type { GatewayRequest, TerminalReason } from "../src/types.js";
import { ControllableModel, VirtualTime, deferred, flushMicrotasks } from "./helpers.js";

function recorder(): { map: Map<string, TerminalReason>; record(id: string): (r: TerminalReason) => void } {
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

test("capability mismatch is never routed; no capable model rejects immediately", async () => {
  const time = new VirtualTime();
  const chatOnly = new ControllableModel("m-chat", ["chat"]);
  const embedder = new ControllableModel("m-embed", ["embeddings"]);
  const gateway = new ModelGateway({
    models: [chatOnly, embedder],
    clock: time,
    scheduler: time,
  });
  const results = recorder();

  gateway.submit({ id: "e1", capability: "embeddings" }).then(results.record("e1"));
  assert.equal(embedder.executeStarted, 1);
  assert.equal(chatOnly.executeStarted, 0);

  gateway.submit({ id: "e2", capability: "embeddings" }).then(results.record("e2"));
  gateway.submit({ id: "e3", capability: "embeddings" }).then(results.record("e3"));
  assert.equal(embedder.executeStarted, 1, "single slot per model");

  gateway.reportHealth("m-embed", false);
  gateway.reportHealth("m-embed", false);
  gateway.reportHealth("m-embed", false);
  await flushMicrotasks();
  assert.deepEqual(results.map.get("e2"), { kind: "rejected", reason: "no-capacity" });
  assert.deepEqual(results.map.get("e3"), { kind: "rejected", reason: "no-capacity" });
  assert.equal(chatOnly.executeStarted, 0, "chat model never sees embeddings work");
});

test("ties break by lexicographic model id", async () => {
  const time = new VirtualTime();
  const zeta = new ControllableModel("zeta", ["chat"]);
  const alpha = new ControllableModel("alpha", ["chat"]);
  const gateway = new ModelGateway({
    models: [zeta, alpha],
    clock: time,
    scheduler: time,
  });
  gateway.submit({ id: "r1", capability: "chat" });
  assert.equal(alpha.executeStarted, 1);
  assert.equal(zeta.executeStarted, 0);
});

test("synchronous execute throw releases the slot and fails the request", async () => {
  const time = new VirtualTime();
  let calls = 0;
  const flaky = {
    id: "m-a",
    capabilities: ["chat"] as const,
    execute(_request: GatewayRequest): Promise<unknown> {
      calls += 1;
      if (calls === 1) throw new Error("sync boom");
      return deferred<unknown>().promise;
    },
  };
  const gateway = new ModelGateway({ models: [flaky], clock: time, scheduler: time });
  const results = recorder();

  gateway.submit({ id: "r1", capability: "chat" }).then(results.record("r1"));
  gateway.submit({ id: "r2", capability: "chat" }).then(results.record("r2"));
  await flushMicrotasks();

  assert.equal(results.map.get("r1")?.kind, "failed");
  assert.equal((results.map.get("r1") as { error: Error }).error.message, "sync boom");
  assert.equal(calls, 2, "slot freed so the queued request starts");
  assert.equal(gateway.snapshot()[0]?.running, "r2");
});

test("models execute concurrently, never serialized globally", async () => {
  const time = new VirtualTime();
  const modelA = new ControllableModel("m-a", ["chat"]);
  const modelB = new ControllableModel("m-b", ["chat"]);
  const gateway = new ModelGateway({
    models: [modelA, modelB],
    clock: time,
    scheduler: time,
  });
  gateway.submit({ id: "r1", capability: "chat" });
  gateway.submit({ id: "r2", capability: "chat" });
  gateway.submit({ id: "r3", capability: "chat" });
  assert.equal(modelA.executeStarted, 1);
  assert.equal(modelB.executeStarted, 1, "second model runs while first is busy");
});
