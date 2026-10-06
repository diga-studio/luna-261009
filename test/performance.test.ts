import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BillingService } from '../src/service';
import { BillingEvent } from '../src/types';
import { referenceBill, rng, tmpDbPath, ev, billsEqual, monthStartOf } from './helpers';

const T = (s: string) => Date.parse(s + 'Z');
const HOT_MONTH = T('2025-03-01T00:00:00');
const HOT_MONTH_MS = 31 * 24 * 3_600_000; // 2025-03 共 31 天
const HOT_EVENTS = 200_000;
const TOTAL_EVENTS = 1_000_000;
const SPAN_MONTHS = 60;

/** 生成热点实例在热点月份的 20 万条启停记录（10 万对） */
function hotEvents(): BillingEvent[] {
  const events: BillingEvent[] = [];
  const pairs = HOT_EVENTS / 2;
  const period = HOT_MONTH_MS / pairs;
  for (let i = 0; i < pairs; i++) {
    const start = HOT_MONTH + Math.floor(i * period);
    const stop = HOT_MONTH + Math.floor(i * period + period / 2);
    events.push(ev(`hot-s-${i}`, 'vm-hot', start, 'start'));
    events.push(ev(`hot-t-${i}`, 'vm-hot', stop, 'stop'));
  }
  return events;
}

/** 生成其余 80 万条记录：200 个实例、跨度 60 个月 */
function backgroundEvents(): BillingEvent[] {
  const events: BillingEvent[] = [];
  const instances = 200;
  const pairsPerInstance = (TOTAL_EVENTS - HOT_EVENTS) / 2 / instances; // 2000 对/实例
  const base = T('2021-01-01T00:00:00');
  for (let j = 0; j < instances; j++) {
    const id = `vm-bg-${j}`;
    for (let k = 0; k < pairsPerInstance; k++) {
      const monthOffset = k % SPAN_MONTHS;
      const monthStart = Date.UTC(2021, monthOffset, 1);
      const within = Math.floor(((k * 7919 + j * 104729) % 2_000_000_000) / 2);
      events.push(ev(`bg-${j}-${k}-s`, id, monthStart + within, 'start'));
      events.push(ev(`bg-${j}-${k}-t`, id, monthStart + within + 60_000, 'stop'));
    }
  }
  void base;
  return events;
}

test('热点负载：100 万记录下账单查看与交替补报满足耗时要求', { timeout: 300_000 }, () => {
  const dbPath = tmpDbPath('perf.db');
  const service = new BillingService(dbPath);
  const hot = hotEvents();
  const background = backgroundEvents();

  // 初始数据装载（不计时）
  const loadStart = performance.now();
  service.recordAll(background);
  service.recordAll(hot);
  const loadMs = performance.now() - loadStart;
  console.log(`装载 ${TOTAL_EVENTS} 条记录耗时 ${loadMs.toFixed(0)}ms`);

  // 预热：首次查看触发热点月事件装载（不计时）
  const baseline = service.getMonthlyBill('vm-hot', HOT_MONTH);

  // 结果正确性：与独立参考实现一致
  const expectedBaseline = referenceBill('vm-hot', hot, monthStartOf(HOT_MONTH));
  assert.ok(billsEqual(baseline, expectedBaseline), '热点月初始账单与参考结果一致');

  // 计时 1：连续 1000 次账单查看 <= 3s
  const viewStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    service.getMonthlyBill('vm-hot', HOT_MONTH);
  }
  const viewMs = performance.now() - viewStart;
  console.log(`连续 1000 次账单查看耗时 ${viewMs.toFixed(0)}ms`);
  assert.ok(viewMs < 3_000, `1000 次查看 ${viewMs.toFixed(0)}ms 超过 3s`);

  // 计时 2：交替补录 1000 条历史记录（位置随机，不保证接近月末）并查看
  const rand = rng(2025);
  const backfills: BillingEvent[] = [];
  const allHot = [...hot];
  const backfillStart = performance.now();
  for (let i = 0; i < 1000; i++) {
    const at = HOT_MONTH + Math.floor(rand() * HOT_MONTH_MS);
    const kind = rand() < 0.5 ? 'start' : 'stop';
    const backfill = ev(`bf-${i}`, 'vm-hot', at, kind);
    service.record(backfill);
    backfills.push(backfill);
    allHot.push(backfill);
    const bill = service.getMonthlyBill('vm-hot', HOT_MONTH);
    // 每次查看都校验账单内部一致性
    const lineSum = bill.lines.reduce((sum, l) => sum + l.amountCents, 0n);
    assert.equal(bill.totalCents, lineSum);
    const msSum = bill.lines.reduce((sum, l) => sum + l.runningMs, 0);
    assert.ok(msSum <= HOT_MONTH_MS);
    // 每 100 次与独立参考实现全量核对一次
    if (i % 100 === 99) {
      const expected = referenceBill('vm-hot', allHot, monthStartOf(HOT_MONTH));
      assert.ok(billsEqual(bill, expected), `第 ${i + 1} 次补报后账单与参考结果一致`);
    }
  }
  const backfillMs = performance.now() - backfillStart;
  console.log(`交替补报 1000 条并查看耗时 ${backfillMs.toFixed(0)}ms`);
  assert.ok(backfillMs < 10_000, `交替补报+查看 ${backfillMs.toFixed(0)}ms 超过 10s`);

  // 补报前后结果确实不同，且最终结果与参考一致
  const finalBill = service.getMonthlyBill('vm-hot', HOT_MONTH);
  assert.ok(!billsEqual(finalBill, baseline), '补报后账单发生变化');
  assert.ok(billsEqual(finalBill, referenceBill('vm-hot', allHot, monthStartOf(HOT_MONTH))));

  // 重启后结果不丢失
  service.close();
  const reopened = new BillingService(dbPath);
  assert.ok(billsEqual(reopened.getMonthlyBill('vm-hot', HOT_MONTH), finalBill), '重启后账单结果不变');
  reopened.close();
});
