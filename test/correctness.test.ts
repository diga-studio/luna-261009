import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingService } from '../src/service';
import { BillingEvent } from '../src/types';
import { referenceBill, shuffled, rng, tmpDbPath, ev, billsEqual, monthStartOf } from './helpers';

const T = (s: string) => Date.parse(s + 'Z');

/** 覆盖：跨月运行、停止期间改套餐、同刻启停+改套餐、月界时刻 */
function scenarioEvents(): BillingEvent[] {
  return [
    ev('e01', 'vm-1', T('2025-01-10T08:00:00'), 'start'),
    ev('e02', 'vm-1', T('2025-01-12T09:00:00'), 'plan', 'Medium'),
    ev('e03', 'vm-1', T('2025-01-15T10:00:00'), 'stop'),
    ev('e04', 'vm-1', T('2025-01-20T11:00:00'), 'plan', 'Large'), // 停止期间改套餐
    ev('e05', 'vm-1', T('2025-02-01T00:00:00.000'), 'start'), // 恰在月界启动
    ev('e06', 'vm-1', T('2025-02-10T00:00:00'), 'stop'),
    ev('e07', 'vm-1', T('2025-02-10T00:00:00'), 'plan', 'Small'), // 与 stop 同刻
    ev('e08', 'vm-1', T('2025-03-01T00:00:00.000'), 'start'), // 恰在月界
    ev('e09', 'vm-1', T('2025-03-05T12:00:00'), 'plan', 'Medium'),
    ev('e10', 'vm-1', T('2025-03-15T08:00:00'), 'start'), // 运行中重复 start
    ev('e11', 'vm-1', T('2025-03-15T08:00:00'), 'plan', 'Large'), // 与 start 同刻
    ev('e12', 'vm-1', T('2025-03-20T00:00:00'), 'stop'),
    ev('e13', 'vm-1', T('2025-03-31T23:59:59.999'), 'plan', 'Small'), // 月末前 1ms
    ev('e14', 'vm-2', T('2025-02-14T00:00:00'), 'start'),
    ev('e15', 'vm-2', T('2025-02-14T01:00:00'), 'stop'),
    ev('e16', 'vm-3', T('2025-01-15T00:00:00'), 'start'), // 跨整个二月运行
    ev('e17', 'vm-3', T('2025-03-15T00:00:00'), 'stop'),
  ];
}

const MONTHS = [
  T('2025-01-01T00:00:00'),
  T('2025-02-01T00:00:00'),
  T('2025-03-01T00:00:00'),
  T('2025-04-01T00:00:00'),
];
const INSTANCES = ['vm-1', 'vm-2', 'vm-3', 'vm-empty'];

function assertAllMonths(service: BillingService, events: BillingEvent[]): void {
  for (const instanceId of INSTANCES) {
    
    for (const month of MONTHS) {
      const expected = referenceBill(instanceId, events, monthStartOf(month));
      const actual = service.getMonthlyBill(instanceId, month);
      assert.ok(
        billsEqual(actual, expected),
        `${instanceId} @ ${new Date(month).toISOString()}\nactual:   ${JSON.stringify(actual, bigintReplacer)}\nexpected: ${JSON.stringify(expected, bigintReplacer)}`,
      );
    }
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

test('乱序送达 + 重复投递，所有月账单与完整时间轴参考结果一致', () => {
  const events = scenarioEvents();
  const orders: BillingEvent[][] = [
    [...events].sort((a, b) => a.effectiveAt - b.effectiveAt),
    [...events].sort((a, b) => b.effectiveAt - a.effectiveAt),
  ];
  for (let seed = 1; seed <= 5; seed++) {
    const rand = rng(seed);
    // 乱序 + 每条记录随机重放
    const withReplays = shuffled(events, rand).flatMap((e) =>
      rand() < 0.5 ? [e, e] : [e],
    );
    orders.push(shuffled(withReplays, rand));
  }

  for (const [idx, order] of orders.entries()) {
    const service = new BillingService(':memory:');
    for (const e of order) service.record(e);
    assertAllMonths(service, events);
    service.close();
    void idx;
  }
});

test('历史补报后，后续查看反映新记录（不封账）', () => {
  const events = scenarioEvents();
  const service = new BillingService(':memory:');
  for (const e of events) service.record(e);
  const before = service.getMonthlyBill('vm-2', T('2025-02-01T00:00:00'));

  // 补报二月更早的一段运行记录
  const extra = ev('e-extra', 'vm-2', T('2025-02-01T00:00:00'), 'start');
  const extraStop = ev('e-extra-2', 'vm-2', T('2025-02-02T00:00:00'), 'stop');
  service.record(extra);
  service.record(extraStop);

  const all = [...events, extra, extraStop];
  const expected = referenceBill('vm-2', all, monthStartOf(T('2025-02-01T00:00:00')));
  const after = service.getMonthlyBill('vm-2', T('2025-02-01T00:00:00'));
  assert.ok(billsEqual(after, expected));
  assert.notEqual(after.totalCents, before.totalCents);
  service.close();
});

test('正常重启后记录与账单结果不丢失', () => {
  const events = scenarioEvents();
  const path = tmpDbPath('restart.db');

  const first = new BillingService(path);
  for (const e of shuffled(events, rng(42))) service_record(first, e);
  assertAllMonths(first, events);
  first.close();

  // 重启：新实例打开同一文件
  const second = new BillingService(path);
  assertAllMonths(second, events);

  // 重启后继续补报历史记录，结果仍与参考一致
  const late = ev('e-late', 'vm-1', T('2025-01-05T00:00:00'), 'plan', 'Large');
  second.record(late);
  assertAllMonths(second, [...events, late]);
  second.close();
});

function service_record(service: BillingService, e: BillingEvent): void {
  service.record(e);
}
