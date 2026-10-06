import test from "node:test";
import assert from "node:assert/strict";
import { InferenceGateway, WAIT_TIMEOUT_MS } from "./gateway.js";
import { FakeScheduler, ManualExecute, flushMicrotasks } from "./testkit.js";
import type { ModelDefinition } from "./types.js";

function chatModel(id: string, manual: ManualExecute): ModelDefinition {
  return { id, capabilities: ["chat"], execute: manual.execute };
}

test("no capable model rejects immediately without hidden queue", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const gateway = new InferenceGateway([chatModel("m1", e1)], scheduler);

  const outcome = await gateway.submit({ id: "emb", capability: "embeddings" });
  assert.deepEqual(outcome, { status: "failed", reason: "no-capacity" });
  assert.deepEqual(gateway.snapshot()[0].waiting, []);
});

test("full waiting room rejects new submissions immediately", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const gateway = new InferenceGateway([chatModel("m1", e1)], scheduler);

  void gateway.submit({ id: "run", capability: "chat" });
  for (let i = 0; i < 20; i++) {
    void gateway.submit({ id: `w${i}`, capability: "chat" });
  }
  assert.equal(gateway.snapshot()[0].waiting.length, 20);

  const overflow = await gateway.submit({ id: "overflow", capability: "chat" });
  assert.deepEqual(overflow, { status: "failed", reason: "no-capacity" });
  assert.equal(gateway.snapshot()[0].waiting.length, 20);
});

test("waiting request times out at 45s and frees its queue slot", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const gateway = new InferenceGateway([chatModel("m1", e1)], scheduler);

  void gateway.submit({ id: "run", capability: "chat" });
  const w = gateway.submit({ id: "w", capability: "chat" });
  assert.equal(gateway.snapshot()[0].waiting.length, 1);

  scheduler.advanceBy(WAIT_TIMEOUT_MS - 1);
  await flushMicrotasks();
  let settled = false;
  void w.then(() => {
    settled = true;
  });
  await flushMicrotasks();
  assert.equal(settled, false);

  scheduler.advanceBy(1);
  assert.deepEqual(await w, { status: "failed", reason: "timeout" });
  assert.deepEqual(gateway.snapshot()[0].waiting, []);
  assert.equal(e1.callCount, 1);
});

test("success resets failure count and restores degraded model", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const gateway = new InferenceGateway([chatModel("m1", e1)], scheduler);

  gateway.reportHealth("m1", false);
  gateway.reportHealth("m1", false);
  gateway.reportHealth("m1", true); // resets the streak
  gateway.reportHealth("m1", false);
  gateway.reportHealth("m1", false);
  assert.equal(gateway.snapshot()[0].healthy, true); // not 3 in a row

  gateway.reportHealth("m1", false); // third consecutive -> degraded
  assert.equal(gateway.snapshot()[0].healthy, false);

  // degraded model rejects routing
  const rejected = await gateway.submit({ id: "x", capability: "chat" });
  assert.deepEqual(rejected, { status: "failed", reason: "no-capacity" });

  // one success restores health; new requests route again
  gateway.reportHealth("m1", true);
  assert.equal(gateway.snapshot()[0].healthy, true);
  void gateway.submit({ id: "y", capability: "chat" });
  assert.equal(e1.callCount, 1);
  assert.equal(e1.calls[0].id, "y");
});

test("capability routing and parallel execution across models", async () => {
  const scheduler = new FakeScheduler();
  const chat = new ManualExecute();
  const embed = new ManualExecute();
  const gateway = new InferenceGateway(
    [
      { id: "chat-model", capabilities: ["chat"], execute: chat.execute },
      { id: "embed-model", capabilities: ["embeddings"], execute: embed.execute },
    ],
    scheduler,
  );

  const chatOutcome = gateway.submit({ id: "c", capability: "chat" });
  const embedOutcome = gateway.submit({ id: "e", capability: "embeddings" });
  // both run concurrently; neither blocks the other
  assert.equal(chat.callCount, 1);
  assert.equal(embed.callCount, 1);

  embed.resolve(0, [0.1, 0.2]);
  await flushMicrotasks();
  assert.deepEqual(await embedOutcome, {
    status: "completed",
    value: [0.1, 0.2],
  });
  assert.equal(gateway.snapshot()[0].running, "c"); // chat still running

  chat.resolve(0, "hi");
  await flushMicrotasks();
  assert.deepEqual(await chatOutcome, { status: "completed", value: "hi" });
});

test("already-aborted signal cancels submission without routing", async () => {
  const scheduler = new FakeScheduler();
  const e1 = new ManualExecute();
  const gateway = new InferenceGateway([chatModel("m1", e1)], scheduler);

  const controller = new AbortController();
  controller.abort();
  const outcome = await gateway.submit(
    { id: "x", capability: "chat" },
    controller.signal,
  );
  assert.deepEqual(outcome, { status: "failed", reason: "cancelled" });
  assert.equal(e1.callCount, 0);
  assert.equal(gateway.snapshot()[0].running, null);
});
