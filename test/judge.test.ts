import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExperimentStore } from "../src/index.js";
import type { ExperimentEvent, VariantStats } from "../src/index.js";

function exposure(eventId: string, visitorId: string, variantId: string): ExperimentEvent {
  return { eventId, visitorId, variantId, type: "exposure" };
}

function conversion(eventId: string, visitorId: string, variantId: string): ExperimentEvent {
  return { eventId, visitorId, variantId, type: "conversion" };
}

function statsOf(result: { stats: VariantStats[] }, variantId: string): VariantStats {
  const found = result.stats.find((s) => s.variantId === variantId);
  assert.ok(found, `variant ${variantId} missing`);
  return found;
}

function withStore(fn: (store: ExperimentStore, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ab-judge-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new ExperimentStore(dbPath);
  try {
    fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("转化先到、重复上报、199 跨 200 首次锁定", () => {
  withStore((store) => {
    store.createExperiment("exp1", ["A", "B"]);

    // B 变体：200 曝光、80 转化，一次到位
    const bEvents: ExperimentEvent[] = [];
    for (let i = 0; i < 200; i++) {
      bEvents.push(exposure(`b-exp-${i}`, `bv${i}`, "B"));
    }
    for (let i = 0; i < 80; i++) {
      bEvents.push(conversion(`b-conv-${i}`, `bv${i}`, "B"));
    }
    store.ingestBatch("exp1", bEvents);
    let result = store.getResult("exp1");
    assert.deepEqual(statsOf(result, "B"), { variantId: "B", n: 200, c: 80 });
    assert.equal(result.lock, null);

    // 转化先到：未曝光前不计入 n 也不计入 c
    store.ingestBatch("exp1", [conversion("a-conv-first", "av0", "A")]);
    result = store.getResult("exp1");
    assert.deepEqual(statsOf(result, "A"), { variantId: "A", n: 0, c: 0 });

    // 曝光到达后同时补入 n 和 c
    store.ingestBatch("exp1", [exposure("a-exp-0", "av0", "A")]);
    result = store.getResult("exp1");
    assert.deepEqual(statsOf(result, "A"), { variantId: "A", n: 1, c: 1 });

    // 重复上报：同一事件标识被忽略；不同事件标识的同类行为也不增计
    store.ingestBatch("exp1", [
      conversion("a-conv-first", "av0", "A"), // 同事件标识重复
      conversion("a-conv-first-dup", "av0", "A"), // 换标识重复转化
      exposure("a-exp-0", "av0", "A"), // 同事件标识重复曝光
      exposure("a-exp-0-dup", "av0", "A"), // 换标识重复曝光
    ]);
    result = store.getResult("exp1");
    assert.deepEqual(statsOf(result, "A"), { variantId: "A", n: 1, c: 1 });

    // A 补到 199 曝光、100 转化（含重复上报干扰）
    const aEvents: ExperimentEvent[] = [];
    for (let i = 1; i < 199; i++) {
      aEvents.push(exposure(`a-exp-${i}`, `av${i}`, "A"));
    }
    aEvents.push(exposure("a-exp-1", "av1", "A")); // 同标识重复
    aEvents.push(exposure("a-exp-2-again", "av2", "A")); // 换标识重复曝光
    for (let i = 1; i < 100; i++) {
      aEvents.push(conversion(`a-conv-${i}`, `av${i}`, "A"));
    }
    aEvents.push(conversion("a-conv-1", "av1", "A")); // 同标识重复
    aEvents.push(conversion("a-conv-3-again", "av3", "A")); // 换标识重复转化
    store.ingestBatch("exp1", aEvents);
    result = store.getResult("exp1");
    assert.deepEqual(statsOf(result, "A"), { variantId: "A", n: 199, c: 100 });
    assert.equal(result.lock, null, "A 只有 199 曝光，不能判胜");

    // 第 200 个曝光到达：首次满足判胜条件并锁定
    store.ingestBatch("exp1", [exposure("a-exp-199", "av199", "A")]);
    result = store.getResult("exp1");
    assert.deepEqual(statsOf(result, "A"), { variantId: "A", n: 200, c: 100 });
    assert.ok(result.lock, "全部变体达到 200 且 Z 达标，应锁定");
    assert.equal(result.lock.triggerEventId, "a-exp-199");
    assert.equal(result.lock.winnerVariantId, "A");
    assert.deepEqual(statsOf(result.lock, "A"), { variantId: "A", n: 200, c: 100 });
    assert.deepEqual(statsOf(result.lock, "B"), { variantId: "B", n: 200, c: 80 });
  });
});

test("同批先达标后优势消失，锁定证据保留在首次达标事件", () => {
  withStore((store) => {
    store.createExperiment("exp2", ["A", "B"]);

    const setup: ExperimentEvent[] = [];
    for (let i = 0; i < 200; i++) {
      setup.push(exposure(`b-exp-${i}`, `bv${i}`, "B"));
    }
    for (let i = 0; i < 80; i++) {
      setup.push(conversion(`b-conv-${i}`, `bv${i}`, "B"));
    }
    for (let i = 0; i < 199; i++) {
      setup.push(exposure(`a-exp-${i}`, `av${i}`, "A"));
    }
    for (let i = 0; i < 100; i++) {
      setup.push(conversion(`a-conv-${i}`, `av${i}`, "A"));
    }
    store.ingestBatch("exp2", setup);
    assert.equal(store.getResult("exp2").lock, null);

    // 同一批内：先到 200 触发锁定，随后 B 转化涌入使优势消失
    const batch: ExperimentEvent[] = [exposure("a-exp-199", "av199", "A")];
    for (let i = 80; i < 120; i++) {
      batch.push(conversion(`b-conv-${i}`, `bv${i}`, "B"));
    }
    store.ingestBatch("exp2", batch);

    const result = store.getResult("exp2");
    // 实时统计继续更新：B 转化率已反超
    assert.deepEqual(statsOf(result, "A"), { variantId: "A", n: 200, c: 100 });
    assert.deepEqual(statsOf(result, "B"), { variantId: "B", n: 200, c: 120 });
    // 锁定证据停留在首次达标事件
    assert.ok(result.lock);
    assert.equal(result.lock.triggerEventId, "a-exp-199");
    assert.equal(result.lock.winnerVariantId, "A");
    assert.deepEqual(statsOf(result.lock, "A"), { variantId: "A", n: 200, c: 100 });
    assert.deepEqual(statsOf(result.lock, "B"), { variantId: "B", n: 200, c: 80 });

    // 后续批次继续更新实时统计，但锁定不变
    const more: ExperimentEvent[] = [];
    for (let i = 120; i < 160; i++) {
      more.push(conversion(`b-conv-${i}`, `bv${i}`, "B"));
    }
    store.ingestBatch("exp2", more);
    const after = store.getResult("exp2");
    assert.deepEqual(statsOf(after, "B"), { variantId: "B", n: 200, c: 160 });
    assert.deepEqual(after.lock, result.lock);
  });
});

test("结果持久化在 SQLite 文件中，重开后仍可读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-judge-"));
  const dbPath = join(dir, "persist.sqlite");
  try {
    const store = new ExperimentStore(dbPath);
    store.createExperiment("exp3", ["A", "B", "C"]);
    const events: ExperimentEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(exposure(`a-exp-${i}`, `av${i}`, "A"));
      events.push(exposure(`b-exp-${i}`, `bv${i}`, "B"));
      events.push(exposure(`c-exp-${i}`, `cv${i}`, "C"));
    }
    for (let i = 0; i < 100; i++) {
      events.push(conversion(`a-conv-${i}`, `av${i}`, "A"));
    }
    for (let i = 0; i < 80; i++) {
      events.push(conversion(`b-conv-${i}`, `bv${i}`, "B"));
      events.push(conversion(`c-conv-${i}`, `cv${i}`, "C"));
    }
    store.ingestBatch("exp3", events);
    store.close();

    const reopened = new ExperimentStore(dbPath);
    const result = reopened.getResult("exp3");
    assert.ok(result.lock);
    assert.equal(result.lock.winnerVariantId, "A");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
