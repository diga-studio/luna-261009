import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingService } from '../src/service';
import { priceToCents } from '../src/billing';
import { ev, monthStartOf } from './helpers';

const T = (s: string) => Date.parse(s + 'Z');
const HOUR = 3_600_000;

test('priceToCents：恰好半分向上取整，全程整数运算', () => {
  // Small $0.015/h = 1.5 美分/小时：1 小时 = 1.5 分 -> 2 分
  assert.equal(priceToCents(HOUR, 15_000n), 2n);
  // Medium $0.045/h：1 小时 = 4.5 分 -> 5 分
  assert.equal(priceToCents(HOUR, 45_000n), 5n);
  // Large $0.12/h = 12 分/小时：1/24 小时 = 0.5 分 -> 1 分
  assert.equal(priceToCents(HOUR / 24, 120_000n), 1n);
  // 略低于半分 -> 向下；略高于半分 -> 向上
  assert.equal(priceToCents(HOUR / 24 - 1, 120_000n), 0n);
  assert.equal(priceToCents(HOUR / 24 + 1, 120_000n), 1n);
  // 整分不变
  assert.equal(priceToCents(HOUR, 120_000n), 12n);
  assert.equal(priceToCents(0, 15_000n), 0n);
});

test('同一套餐用量被多次启停切碎，费用与整块用量一致', () => {
  const service = new BillingService(':memory:');
  const m0 = T('2025-03-01T00:00:00');
  // 4 段 15 分钟 = 1 小时 Small
  for (let i = 0; i < 4; i++) {
    service.record(ev(`f-s-${i}`, 'vm-frag', m0 + i * 2 * 900_000, 'start'));
    service.record(ev(`f-t-${i}`, 'vm-frag', m0 + i * 2 * 900_000 + 900_000, 'stop'));
  }
  const bill = service.getMonthlyBill('vm-frag', m0);
  assert.equal(bill.lines.length, 1);
  assert.equal(bill.lines[0].plan, 'Small');
  assert.equal(bill.lines[0].runningMs, HOUR);
  assert.equal(bill.lines[0].amountCents, 2n); // 与整块 1 小时相同
  assert.equal(bill.totalCents, 2n);

  // 对照：2 段 15 分钟 = 30 分钟 = 0.75 分 -> 1 分（逐段舍入会得 0）
  const service2 = new BillingService(':memory:');
  service2.record(ev('h-s-0', 'vm-half', m0, 'start'));
  service2.record(ev('h-t-0', 'vm-half', m0 + 900_000, 'stop'));
  service2.record(ev('h-s-1', 'vm-half', m0 + 2 * 900_000, 'start'));
  service2.record(ev('h-t-1', 'vm-half', m0 + 3 * 900_000, 'stop'));
  const bill2 = service2.getMonthlyBill('vm-half', m0);
  assert.equal(bill2.lines[0].runningMs, 1_800_000);
  assert.equal(bill2.lines[0].amountCents, 1n);
  service.close();
  service2.close();
});

test('总额等于各项已舍入费用之和', () => {
  const service = new BillingService(':memory:');
  const m0 = T('2025-05-01T00:00:00');
  // Small 跑 1 小时（1.5 -> 2），改 Medium 跑 1 小时（4.5 -> 5）
  service.record(ev('s1', 'vm-sum', m0, 'start'));
  service.record(ev('p1', 'vm-sum', m0 + HOUR, 'plan', 'Medium'));
  service.record(ev('s2', 'vm-sum', m0 + 2 * HOUR, 'stop'));
  const bill = service.getMonthlyBill('vm-sum', m0);
  assert.equal(bill.lines.length, 2);
  const small = bill.lines.find((l) => l.plan === 'Small')!;
  const medium = bill.lines.find((l) => l.plan === 'Medium')!;
  assert.equal(small.amountCents, 2n);
  assert.equal(medium.amountCents, 5n);
  assert.equal(bill.totalCents, small.amountCents + medium.amountCents);
  service.close();
});

test('闰年二月：整月运行按 29 天计费', () => {
  const service = new BillingService(':memory:');
  const feb2024 = T('2024-02-01T00:00:00');
  service.record(ev('leap-s', 'vm-leap', feb2024, 'start'));
  service.record(ev('leap-t', 'vm-leap', T('2024-03-01T00:00:00'), 'stop')); // 月末界停止
  const bill = service.getMonthlyBill('vm-leap', feb2024);
  const expectedMs = 29 * 24 * HOUR;
  assert.equal(bill.lines[0].runningMs, expectedMs);
  assert.equal(bill.lines[0].amountCents, priceToCents(expectedMs, 15_000n)); // 696h * 1.5 = 1044
  assert.equal(bill.totalCents, 1044n);

  // 非闰年二月为 28 天
  const feb2025 = T('2025-02-01T00:00:00');
  service.record(ev('ny-s', 'vm-nonleap', feb2025, 'start'));
  service.record(ev('ny-t', 'vm-nonleap', T('2025-03-01T00:00:00'), 'stop'));
  const bill2 = service.getMonthlyBill('vm-nonleap', feb2025);
  assert.equal(bill2.lines[0].runningMs, 28 * 24 * HOUR);
  service.close();
});

test('月界时刻：左含右不含，月末生效记录不影响本月', () => {
  const service = new BillingService(':memory:');
  const m0 = T('2025-06-01T00:00:00');
  const m1 = T('2025-07-01T00:00:00');
  // 恰在月初启动、恰在下月月初停止：整月计费
  service.record(ev('b-s', 'vm-bound', m0, 'start'));
  service.record(ev('b-t', 'vm-bound', m1, 'stop'));
  // 恰在月末界改套餐：不影响本月
  service.record(ev('b-p', 'vm-bound', m1, 'plan', 'Large'));
  const june = service.getMonthlyBill('vm-bound', m0);
  assert.equal(june.monthStart, m0);
  assert.equal(june.monthEnd, m1);
  assert.equal(june.lines.length, 1);
  assert.equal(june.lines[0].plan, 'Small');
  assert.equal(june.lines[0].runningMs, 30 * 24 * HOUR);

  // 七月：月初状态为运行中 + Large（由 7/1 0 点的 stop 立即结束）
  const july = service.getMonthlyBill('vm-bound', m1);
  assert.equal(july.lines.length, 0);
  assert.equal(july.totalCents, 0n);

  // 月末前 1ms 启动：本月只计 1ms
  service.record(ev('c-s', 'vm-edge', m1 - 1, 'start'));
  service.record(ev('c-t', 'vm-edge', m1, 'stop'));
  const juneEdge = service.getMonthlyBill('vm-edge', m0);
  assert.equal(juneEdge.lines[0].runningMs, 1);
  service.close();
});

test('无任何记录的实例：空账单', () => {
  const service = new BillingService(':memory:');
  const bill = service.getMonthlyBill('ghost', T('2025-01-01T00:00:00'));
  assert.equal(bill.lines.length, 0);
  assert.equal(bill.totalCents, 0n);
  service.close();
});
