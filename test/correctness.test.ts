import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BillingService } from "../src/index.js";
import type { LifecycleRecord } from "../src/index.js";
import { referenceBill } from "./reference.js";

/** 可复现的伪随机数（LCG）。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** 在序列中随机插入重放（重复）记录。 */
function withReplays(
  records: LifecycleRecord[],
  rng: () => number,
): LifecycleRecord[] {
  const out: LifecycleRecord[] = [];
  for (const rec of records) {
    out.push(rec);
    while (rng() < 0.3) out.push(rec);
  }
  return out;
}

const HOUR = 3_600_000;
const at = (iso: string): number => Date.parse(iso);

/** 手工场景：跨月、停止中改套餐、同刻启停+改套餐、月界时刻。 */
function scenarioRecords(): LifecycleRecord[] {
  const id = "vm-hand";
  let seq = 0;
  const rec = (
    effectiveAt: number,
    kind: LifecycleRecord["kind"],
    plan?: LifecycleRecord["plan"],
  ): LifecycleRecord => ({
    eventId: `hand-${seq++}`,
    instanceId: id,
    effectiveAt,
    kind,
    ...(plan ? { plan } : {}),
  });
  return [
    // 1 月：普通启停。
    rec(at("2024-01-15T10:00:00.000Z"), "start"),
    rec(at("2024-01-20T10:00:00.000Z"), "stop"),
    // 2 月 1 日 0 点整（月界）停止中改套餐。
    rec(at("2024-02-01T00:00:00.000Z"), "plan", "medium"),
    // 同一时刻启动 + 改套餐。
    rec(at("2024-02-10T08:00:00.000Z"), "start"),
    rec(at("2024-02-10T08:00:00.000Z"), "plan", "large"),
    // 闰年 2 月 29 日停止。
    rec(at("2024-02-29T12:00:00.000Z"), "stop"),
    // 停止中降回 small。
    rec(at("2024-03-05T00:00:00.000Z"), "plan", "small"),
    // 跨月运行区间：3 月末启动，4 月初停止。
    rec(at("2024-03-31T23:00:00.000Z"), "start"),
    rec(at("2024-04-01T01:00:00.000Z"), "stop"),
    // 恰好月末边界生效的套餐变更：不影响 3 月。
    rec(at("2024-04-01T00:00:00.000Z"), "plan", "medium"),
    // 4 月末启动，恰好 5 月 1 日 0 点停止：4 月含 1 小时，5 月为 0。
    rec(at("2024-04-30T23:00:00.000Z"), "start"),
    rec(at("2024-05-01T00:00:00.000Z"), "stop"),
  ];
}

const MONTHS: Array<[number, number]> = [
  [2024, 1],
  [2024, 2],
  [2024, 3],
  [2024, 4],
  [2024, 5],
];

function assertBillsMatch(
  service: BillingService,
  allRecords: LifecycleRecord[],
  instanceId: string,
): void {
  for (const [year, month] of MONTHS) {
    assert.deepEqual(
      service.getMonthlyBill(instanceId, year, month),
      referenceBill(allRecords, instanceId, year, month),
      `bill mismatch for ${year}-${month}`,
    );
  }
}

test("手工场景：任意送达顺序 + 重放，账单与参考实现一致", () => {
  const records = scenarioRecords();
  const rng = makeRng(42);
  for (let round = 0; round < 8; round++) {
    const service = new BillingService(":memory:");
    service.ingestBatch(withReplays(shuffled(records, rng), rng));
    assertBillsMatch(service, records, "vm-hand");
    service.close();
  }
});

test("手工场景：逐条乱序补录，每步后账单仍一致", () => {
  const records = scenarioRecords();
  const rng = makeRng(7);
  const service = new BillingService(":memory:");
  const ingested: LifecycleRecord[] = [];
  for (const rec of shuffled(records, rng)) {
    service.ingest(rec);
    ingested.push(rec);
    assertBillsMatch(service, ingested, "vm-hand");
  }
  service.close();
});

test("正常重启后账单不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "billing-"));
  try {
    const dbPath = join(dir, "billing.sqlite");
    const records = scenarioRecords();
    const rng = makeRng(99);
    const service = new BillingService(dbPath);
    service.ingestBatch(withReplays(shuffled(records, rng), rng));
    const before = MONTHS.map(([y, m]) => service.getMonthlyBill("vm-hand", y, m));
    service.close();

    const reopened = new BillingService(dbPath);
    const after = MONTHS.map(([y, m]) => reopened.getMonthlyBill("vm-hand", y, m));
    assert.deepEqual(after, before);
    assertBillsMatch(reopened, records, "vm-hand");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("随机模糊：多实例随机记录乱序+重放，全部月份与参考一致", () => {
  const rng = makeRng(2024);
  const instances = ["vm-a", "vm-b", "vm-c"];
  const base = at("2024-01-01T00:00:00.000Z");
  const span = 91 * 24 * HOUR; // 约三个月
  const records: LifecycleRecord[] = [];
  let seq = 0;
  for (const instanceId of instances) {
    const usedPower = new Set<number>();
    const usedPlan = new Set<number>();
    for (let i = 0; i < 120; i++) {
      const kind =
        rng() < 0.5 ? ("plan" as const) : rng() < 0.5 ? ("start" as const) : ("stop" as const);
      let t = base + Math.floor(rng() * span);
      // 同类事件不共享生效时刻；不同类可同刻。
      const used = kind === "plan" ? usedPlan : usedPower;
      while (used.has(t)) t++;
      used.add(t);
      const rec: LifecycleRecord = {
        eventId: `fz-${seq++}`,
        instanceId,
        effectiveAt: t,
        kind,
        ...(kind === "plan"
          ? { plan: (["small", "medium", "large"] as const)[Math.floor(rng() * 3)]! }
          : {}),
      };
      records.push(rec);
    }
  }
  const service = new BillingService(":memory:");
  service.ingestBatch(withReplays(shuffled(records, rng), rng));
  for (const instanceId of instances) {
    for (const month of [1, 2, 3]) {
      assert.deepEqual(
        service.getMonthlyBill(instanceId, 2024, month),
        referenceBill(records, instanceId, 2024, month),
        `${instanceId} 2024-${month}`,
      );
    }
  }
  service.close();
});
