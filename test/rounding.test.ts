import test from "node:test";
import assert from "node:assert/strict";
import { BillingService } from "../src/index.js";
import type { LifecycleRecord, Plan } from "../src/index.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const at = (iso: string): number => Date.parse(iso);

interface Setup {
  service: BillingService;
  id: string;
}

/** 构造一个实例：startAt 启动（可选先切到 plan），stopAt 停止。 */
function runInterval(
  plan: Plan | null,
  startIso: string,
  stopIso: string,
  id = "vm-r",
): Setup {
  const service = new BillingService(":memory:");
  let seq = 0;
  const records: LifecycleRecord[] = [];
  if (plan !== null) {
    records.push({
      eventId: `${id}-p${seq++}`,
      instanceId: id,
      effectiveAt: at(startIso),
      kind: "plan",
      plan,
    });
  }
  records.push(
    { eventId: `${id}-s${seq++}`, instanceId: id, effectiveAt: at(startIso), kind: "start" },
    { eventId: `${id}-s${seq++}`, instanceId: id, effectiveAt: at(stopIso), kind: "stop" },
  );
  service.ingestBatch(records);
  return { service, id };
}

function lineItem(setup: Setup, year: number, month: number, plan: Plan) {
  const bill = setup.service.getMonthlyBill(setup.id, year, month);
  return {
    bill,
    item: bill.lineItems.find((li) => li.plan === plan)!,
  };
}

test("恰好半分向上取整", () => {
  // small：20 分钟 = 0.5 分 → 1 分
  const a = runInterval(null, "2024-03-10T00:00:00.000Z", "2024-03-10T00:20:00.000Z", "vm-a");
  assert.equal(lineItem(a, 2024, 3, "small").item.costCents, 1);
  a.service.close();

  // small：1 小时 = 1.5 分 → 2 分
  const b = runInterval(null, "2024-03-10T00:00:00.000Z", "2024-03-10T01:00:00.000Z", "vm-b");
  assert.equal(lineItem(b, 2024, 3, "small").item.costCents, 2);
  b.service.close();

  // medium：1 小时 = 4.5 分 → 5 分
  const c = runInterval("medium", "2024-03-10T00:00:00.000Z", "2024-03-10T01:00:00.000Z", "vm-c");
  assert.equal(lineItem(c, 2024, 3, "medium").item.costCents, 5);
  c.service.close();

  // large：150 秒 = 0.5 分 → 1 分
  const d = runInterval("large", "2024-03-10T00:00:00.000Z", "2024-03-10T00:02:30.000Z", "vm-d");
  assert.equal(lineItem(d, 2024, 3, "large").item.costCents, 1);
  d.service.close();

  // small：2 小时 = 3 分整 → 3 分（不涉及舍入）
  const e = runInterval(null, "2024-03-10T00:00:00.000Z", "2024-03-10T02:00:00.000Z", "vm-e");
  assert.equal(lineItem(e, 2024, 3, "small").item.costCents, 3);
  e.service.close();
});

test("同套餐用量被多次启停切碎，费用与整段一致", () => {
  const service = new BillingService(":memory:");
  const id = "vm-frag";
  const records: LifecycleRecord[] = [];
  // 60 个 1 分钟碎片，合计 1 小时 small。
  const base = at("2024-03-10T00:00:00.000Z");
  for (let i = 0; i < 60; i++) {
    records.push(
      { eventId: `f-s${i}`, instanceId: id, effectiveAt: base + i * 2 * MINUTE, kind: "start" },
      { eventId: `f-t${i}`, instanceId: id, effectiveAt: base + i * 2 * MINUTE + MINUTE, kind: "stop" },
    );
  }
  service.ingestBatch(records);
  const { bill, item } = lineItem({ service, id }, 2024, 3, "small");
  assert.equal(item.runningMs, HOUR);
  assert.equal(item.costCents, 2); // 与整段 1 小时相同
  assert.equal(bill.totalCents, 2);
  service.close();
});

test("多套餐碎片分别累计后再各自舍入", () => {
  const service = new BillingService(":memory:");
  const id = "vm-mix";
  const records: LifecycleRecord[] = [];
  const base = at("2024-03-10T00:00:00.000Z");
  // 交替 small/medium 各 3 段 20 分钟（段间留间隔）：各合计 1 小时。
  for (let i = 0; i < 6; i++) {
    const start = base + i * 40 * MINUTE;
    records.push({
      eventId: `m-p${i}`,
      instanceId: id,
      effectiveAt: start,
      kind: "plan",
      plan: i % 2 === 0 ? "small" : "medium",
    });
    records.push({ eventId: `m-s${i}`, instanceId: id, effectiveAt: start, kind: "start" });
    records.push({
      eventId: `m-t${i}`,
      instanceId: id,
      effectiveAt: start + 20 * MINUTE,
      kind: "stop",
    });
  }
  service.ingestBatch(records);
  const bill = service.getMonthlyBill(id, 2024, 3);
  const small = bill.lineItems.find((li) => li.plan === "small")!;
  const medium = bill.lineItems.find((li) => li.plan === "medium")!;
  assert.equal(small.runningMs, HOUR);
  assert.equal(medium.runningMs, HOUR);
  assert.equal(small.costCents, 2); // 1.5 → 2
  assert.equal(medium.costCents, 5); // 4.5 → 5
  assert.equal(bill.totalCents, 7); // 总额为各列项舍入后之和
  service.close();
});

test("闰年二月与平年二月整月运行", () => {
  // 2024 为闰年：2 月 29 天，large 整月 = 29*24 小时 * 12 分 = 8352 分
  const leap = runInterval("large", "2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z", "vm-leap");
  const leapItem = lineItem(leap, 2024, 2, "large");
  assert.equal(leapItem.item.runningMs, 29 * DAY);
  assert.equal(leapItem.item.costCents, 8352);
  leap.service.close();

  // 2025 为平年：2 月 28 天，large 整月 = 28*24*12 = 8064 分
  const plain = runInterval("large", "2025-02-01T00:00:00.000Z", "2025-03-01T00:00:00.000Z", "vm-plain");
  const plainItem = lineItem(plain, 2025, 2, "large");
  assert.equal(plainItem.item.runningMs, 28 * DAY);
  assert.equal(plainItem.item.costCents, 8064);
  plain.service.close();
});

test("跨月运行区间在月界正确切分", () => {
  // 2024-02-28 12:00 → 2024-03-02 12:00，small。
  const setup = runInterval(null, "2024-02-28T12:00:00.000Z", "2024-03-02T12:00:00.000Z", "vm-x");
  const feb = lineItem(setup, 2024, 2, "small");
  const mar = lineItem(setup, 2024, 3, "small");
  assert.equal(feb.item.runningMs, 36 * HOUR); // 2/28 12:00 → 3/1 00:00（含闰日）
  assert.equal(feb.item.costCents, 54); // 36 * 1.5
  assert.equal(mar.item.runningMs, 36 * HOUR);
  assert.equal(mar.item.costCents, 54);
  setup.service.close();
});

test("月初/月末边界时刻的归属", () => {
  const service = new BillingService(":memory:");
  const id = "vm-edge";
  // 恰好 3 月 1 日 0 点启动，恰好 4 月 1 日 0 点停止：整个 3 月运行。
  service.ingestBatch([
    { eventId: "e-1", instanceId: id, effectiveAt: at("2024-03-01T00:00:00.000Z"), kind: "start" },
    { eventId: "e-2", instanceId: id, effectiveAt: at("2024-04-01T00:00:00.000Z"), kind: "stop" },
  ]);
  const feb = service.getMonthlyBill(id, 2024, 2);
  const mar = service.getMonthlyBill(id, 2024, 3);
  const apr = service.getMonthlyBill(id, 2024, 4);
  assert.equal(feb.totalCents, 0);
  assert.equal(mar.lineItems.find((li) => li.plan === "small")!.runningMs, 31 * DAY);
  assert.equal(apr.totalCents, 0);
  service.close();
});
