import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyBill } from '../src/billing';
import { BillingService, monthStartOf, nextMonthStart } from '../src/service';
import { BillingEvent, Plan } from '../src/types';
import { referenceBill, rng, ev, billsEqual } from './helpers';

const PLANS: Plan[] = ['Small', 'Medium', 'Large'];

/** 随机生成一个实例一个月的密集事件流（同类事件不共享生效时刻） */
function randomEvents(seed: number, instanceId: string, monthStart: number, monthMs: number, count: number): BillingEvent[] {
  const rand = rng(seed);
  const usedByKind = new Map<string, Set<number>>();
  const events: BillingEvent[] = [];
  for (let i = 0; i < count; i++) {
    const kind = rand() < 0.45 ? 'start' : rand() < 0.9 ? 'stop' : 'plan';
    let at = monthStart + Math.floor(rand() * monthMs);
    const used = usedByKind.get(kind) ?? new Set<number>();
    while (used.has(at)) at = monthStart + Math.floor(rand() * monthMs);
    used.add(at);
    usedByKind.set(kind, used);
    events.push(ev(`p-${seed}-${i}`, instanceId, at, kind, kind === 'plan' ? PLANS[Math.floor(rand() * 3)] : undefined));
  }
  return events;
}

test('对象版与列式扫描、独立参考实现三者结果一致（随机事件流）', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const monthStart = Date.UTC(2020 + (seed % 7), seed % 12, 1);
    const m0 = monthStartOf(monthStart);
    const monthMs = nextMonthStart(m0) - m0;
    const events = randomEvents(seed, 'vm-parity', m0, monthMs, 500);
    const service = new BillingService(':memory:');
    service.recordAll(events);

    const expected = referenceBill('vm-parity', events, m0);
    const viaService = service.getMonthlyBill('vm-parity', m0);
    const viaObjectApi = computeMonthlyBill(
      'vm-parity',
      expected.monthStart,
      expected.monthEnd,
      false,
      'Small',
      [...events].sort((a, b) => a.effectiveAt - b.effectiveAt),
    );
    assert.ok(billsEqual(viaService, expected), `seed=${seed} 列式路径`);
    assert.ok(billsEqual(viaObjectApi, expected), `seed=${seed} 对象路径`);
    service.close();
  }
});
