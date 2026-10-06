import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PipeLite } from '../src/index';
import { makeContext, GROUPS8 } from './helpers';

/** 确定性伪随机数（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type MState = 'pending' | 'leased' | 'acked' | 'dead';
interface MDelivery {
  state: MState;
  attempts: number;
  receipt: string | null;
  expiresAt: number;
}

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MESSAGE_COUNT = 10_000;

/** 按业务规则独立推导的参考模型。 */
class Model {
  /** deliveries[group][messageId] */
  private d = new Map<string, Map<number, MDelivery>>();
  /** receipt -> (group, messageId)，用于 O(1) 回执查找 */
  private byReceipt = new Map<string, { group: string; id: number }>();
  constructor(
    private groups: string[],
    private priority: Map<number, number>,
  ) {
    for (const g of groups) this.d.set(g, new Map());
  }
  add(messageId: number): void {
    for (const g of this.groups) {
      this.d.get(g)!.set(messageId, { state: 'pending', attempts: 0, receipt: null, expiresAt: 0 });
    }
  }
  /** 单条投递在 now 时刻的有效状态（懒过期，与库的按需落地等价）。 */
  private eff(del: MDelivery, now: number): MState {
    if (del.state === 'leased' && del.expiresAt <= now) {
      return del.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
    }
    return del.state;
  }
  /** 返回期望被领取的消息 id 序列。 */
  expectClaim(group: string, max: number, now: number): number[] {
    const ids: number[] = [];
    for (const [id, del] of this.d.get(group)!) {
      if (this.eff(del, now) === 'pending') ids.push(id);
    }
    ids.sort((a, b) => {
      const pa = this.priority.get(a)!;
      const pb = this.priority.get(b)!;
      return pa !== pb ? pb - pa : a - b;
    });
    return ids.slice(0, max);
  }
  markLeased(group: string, id: number, receipt: string, expiresAt: number): void {
    const del = this.d.get(group)!.get(id)!;
    del.state = 'leased';
    del.attempts += 1;
    del.receipt = receipt;
    del.expiresAt = expiresAt;
    this.byReceipt.set(receipt, { group, id });
  }
  expectAck(group: string, receipt: string, now: number): boolean {
    const ref = this.byReceipt.get(receipt);
    if (!ref || ref.group !== group) return false;
    const del = this.d.get(group)!.get(ref.id)!;
    return this.eff(del, now) === 'leased' && del.receipt === receipt && del.expiresAt > now;
  }
  markAcked(group: string, receipt: string): void {
    const ref = this.byReceipt.get(receipt);
    if (!ref) return;
    const del = this.d.get(ref.group)!.get(ref.id)!;
    del.state = 'acked';
    del.receipt = null;
    this.byReceipt.delete(receipt);
  }
  done(now: number): boolean {
    for (const g of this.groups) {
      for (const del of this.d.get(g)!.values()) {
        const s = this.eff(del, now);
        if (s !== 'acked' && s !== 'dead') return false;
      }
    }
    return true;
  }
  expectStatus(group: string, id: number, now: number): MDelivery {
    const del = this.d.get(group)!.get(id)!;
    return { ...del, state: this.eff(del, now) };
  }
}

test('scale: 10000 messages x 8 groups x 8 consumers per group match independent model', () => {
  const rand = rng(20261009);
  const ctx = makeContext(GROUPS8);
  // 同进程 4 个库实例共享同一文件，8 个消费者/组轮流使用
  const instances = [ctx.open(), ctx.open(), ctx.open(), ctx.open()];
  const priority = new Map<number, number>();
  const model = new Model(GROUPS8, priority);

  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const p = 1 + Math.floor(rand() * 10);
    const id = instances[i % instances.length].enqueue({ i }, p);
    priority.set(id, p);
    model.add(id);
  }

  const heldReceipts: Array<{ group: string; receipt: string; expiresAt: number }> = [];
  let rounds = 0;
  while (!model.done(ctx.clock.now()) && rounds < 500) {
    rounds++;
    ctx.clock.advance(Math.floor(rand() * 15_000));
    for (const group of GROUPS8) {
      for (let consumer = 0; consumer < 8; consumer++) {
        const pl = instances[consumer % instances.length];
        const max = 1 + Math.floor(rand() * 50);
        const expected = model.expectClaim(group, max, ctx.clock.now());
        const batch = pl.claim(group, max);
        assert.deepEqual(
          batch.map((c) => c.messageId),
          expected,
          `round ${rounds} group ${group} claim order`,
        );
        for (const c of batch) {
          assert.equal(c.expiresAt, ctx.clock.now() + LEASE_MS);
          model.markLeased(group, c.messageId, c.receipt, c.expiresAt);
          if (rand() < 0.75) {
            assert.ok(model.expectAck(group, c.receipt, ctx.clock.now()));
            assert.ok(pl.ack(group, c.receipt), 'timely ack must succeed');
            model.markAcked(group, c.receipt);
          } else {
            heldReceipts.push({ group, receipt: c.receipt, expiresAt: c.expiresAt });
          }
        }
      }
      // 每轮抽查持有中的回执：已过期的迟到确认必须无效；未过期的确认后模型同步
      for (let k = 0; k < 4 && heldReceipts.length > 0; k++) {
        const idx = Math.floor(rand() * heldReceipts.length);
        const [stale] = heldReceipts.splice(idx, 1);
        if (stale.group !== group) continue;
        const expected = model.expectAck(stale.group, stale.receipt, ctx.clock.now());
        assert.equal(instances[0].ack(stale.group, stale.receipt), expected, 'stale ack result');
        if (expected) {
          model.markAcked(stale.group, stale.receipt);
        } else {
          assert.ok(
            stale.expiresAt <= ctx.clock.now(),
            'an ack may only fail here if the lease already expired',
          );
        }
      }
    }
  }
  assert.ok(model.done(ctx.clock.now()), `simulation should finish, rounds=${rounds}`);

  // 全量比对：每条消息在每组的状态与尝试次数
  const finalNow = ctx.clock.now();
  let acked = 0;
  let dead = 0;
  for (let id = 1; id <= MESSAGE_COUNT; id++) {
    const status = instances[0].status(id);
    assert.equal(status.length, 8);
    for (const s of status) {
      const exp = model.expectStatus(s.group, id, finalNow);
      assert.equal(s.state, exp.state, `message ${id} group ${s.group} state`);
      assert.equal(s.attempts, exp.attempts, `message ${id} group ${s.group} attempts`);
    }
    if (status[0].state === 'acked') acked++;
    if (status[0].state === 'dead') dead++;
  }
  assert.ok(acked > MESSAGE_COUNT * 0.9, `most messages acked, got ${acked}`);
  assert.ok(dead > 0, 'some messages should reach dead letter');

  // 正常关闭后重开：结果不变
  for (const pl of instances) pl.close();
  const reopened = new PipeLite({ path: ctx.dbPath, groups: GROUPS8, clock: ctx.clock.now });
  for (let id = 1; id <= MESSAGE_COUNT; id += 97) {
    const status = reopened.status(id);
    for (const s of status) {
      const exp = model.expectStatus(s.group, id, ctx.clock.now());
      assert.equal(s.state, exp.state, `reopen message ${id} group ${s.group} state`);
      assert.equal(s.attempts, exp.attempts, `reopen message ${id} group ${s.group} attempts`);
    }
  }
  reopened.close();
  ctx.cleanup();
});
