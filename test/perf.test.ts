import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BillingService } from "../src/index.js";
import type { LifecycleRecord, Plan } from "../src/index.js";
import { referenceBill } from "./reference.js";

const PLANS_LIST: Plan[] = ["small", "medium", "large"];
const HOT_INSTANCE = "vm-hot";
const HOT_YEAR = 2024;
const HOT_MONTH = 6; // 2024-06，处于 60 个月跨度中段
const HOT_START = Date.UTC(HOT_YEAR, HOT_MONTH - 1, 1);
const HOT_RECORDS = 200_000;
const BG_INSTANCES = 100;
const BG_RECORDS_PER_INSTANCE = 8_000; // 合计 80 万，跨 60 个月
const BACKFILL_RECORDS = 1_000;

/** 热点实例在热点月的 20 万条记录（时间互不重叠）。 */
function hotRecords(): LifecycleRecord[] {
  const records: LifecycleRecord[] = [];
  for (let i = 0; i < HOT_RECORDS; i++) {
    const kindCycle = i % 4;
    const kind = kindCycle === 0 ? "start" : kindCycle === 2 ? "stop" : "plan";
    const rec: LifecycleRecord = {
      eventId: `hot-${i}`,
      instanceId: HOT_INSTANCE,
      effectiveAt: HOT_START + i * 12_000,
      kind,
    };
    if (kind === "plan") rec.plan = PLANS_LIST[i % 3]!;
    records.push(rec);
  }
  return records;
}

/** 背景实例记录：100 个实例 × 8000 条，均匀分布于 60 个月。 */
function* backgroundRecords(): Generator<LifecycleRecord> {
  for (let k = 0; k < BG_INSTANCES; k++) {
    const instanceId = `vm-bg-${k}`;
    for (let i = 0; i < BG_RECORDS_PER_INSTANCE; i++) {
      const m = i % 60;
      const monthStart = Date.UTC(2024 + Math.floor(m / 12), m % 12, 1);
      const kindCycle = i % 3;
      const kind = kindCycle === 0 ? "start" : kindCycle === 1 ? "stop" : "plan";
      const rec: LifecycleRecord = {
        eventId: `bg-${k}-${i}`,
        instanceId,
        effectiveAt: monthStart + Math.floor(i / 60) * 15_000_000 + 3,
        kind,
      };
      if (kind === "plan") rec.plan = PLANS_LIST[(i + k) % 3]!;
      yield rec;
    }
  }
}

/** 1000 条补报记录：落在热点月历史任意位置（不与既有同类时刻冲突）。 */
function backfillRecords(): LifecycleRecord[] {
  const records: LifecycleRecord[] = [];
  for (let j = 0; j < BACKFILL_RECORDS; j++) {
    const kindCycle = j % 3;
    const kind = kindCycle === 0 ? "start" : kindCycle === 1 ? "stop" : "plan";
    const rec: LifecycleRecord = {
      eventId: `bf-${j}`,
      instanceId: HOT_INSTANCE,
      effectiveAt: HOT_START + 1_000 + j * 2_500_000,
      kind,
    };
    if (kind === "plan") rec.plan = PLANS_LIST[j % 3]!;
    records.push(rec);
  }
  return records;
}

test("性能：百万记录下热点月查询与交替补报", { timeout: 300_000 }, () => {
  const service = new BillingService(":memory:");
  const hot = hotRecords();

  // 初始数据装载（不计时）。
  const loadStart = performance.now();
  for (let i = 0; i < hot.length; i += 20_000) {
    service.ingestBatch(hot.slice(i, i + 20_000));
  }
  let chunk: LifecycleRecord[] = [];
  for (const rec of backgroundRecords()) {
    chunk.push(rec);
    if (chunk.length === 20_000) {
      service.ingestBatch(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) service.ingestBatch(chunk);
  const loadMs = performance.now() - loadStart;

  // 预热热点实例索引（属于数据装载，不计时）。
  const billBefore = service.getMonthlyBill(HOT_INSTANCE, HOT_YEAR, HOT_MONTH);
  assert.deepEqual(
    billBefore,
    referenceBill(hot, HOT_INSTANCE, HOT_YEAR, HOT_MONTH),
    "装载后账单应与参考一致",
  );

  // 连续 1000 次热点月账单查看。
  const queryStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    service.getMonthlyBill(HOT_INSTANCE, HOT_YEAR, HOT_MONTH);
  }
  const queryMs = performance.now() - queryStart;

  // 交替补报 1000 条历史记录并查看受影响月份。
  const backfills = backfillRecords();
  const backfillStart = performance.now();
  for (const rec of backfills) {
    service.ingest(rec);
    service.getMonthlyBill(HOT_INSTANCE, HOT_YEAR, HOT_MONTH);
  }
  const backfillMs = performance.now() - backfillStart;

  // 补报后结果必须反映新记录。
  const billAfter = service.getMonthlyBill(HOT_INSTANCE, HOT_YEAR, HOT_MONTH);
  assert.deepEqual(
    billAfter,
    referenceBill([...hot, ...backfills], HOT_INSTANCE, HOT_YEAR, HOT_MONTH),
    "补报后账单应与参考一致",
  );
  assert.notDeepEqual(billAfter, billBefore, "补报应改变账单");

  console.log(
    `装载 ${HOT_RECORDS + BG_INSTANCES * BG_RECORDS_PER_INSTANCE} 条: ${loadMs.toFixed(0)}ms; ` +
      `1000 次查询: ${queryMs.toFixed(0)}ms; ` +
      `1000 次交替补报+查询: ${backfillMs.toFixed(0)}ms`,
  );
  assert.ok(queryMs < 3_000, `1000 次查询耗时 ${queryMs.toFixed(0)}ms，超过 3s`);
  assert.ok(backfillMs < 10_000, `交替补报耗时 ${backfillMs.toFixed(0)}ms，超过 10s`);
  service.close();
});
