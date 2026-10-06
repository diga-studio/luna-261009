import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { makeContext } from './helpers';

test('claim returns messages ordered by priority desc, then enqueue order asc', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const m1 = pl.enqueue({ n: 1 }, 5);
  const m2 = pl.enqueue({ n: 2 }, 9);
  const m3 = pl.enqueue({ n: 3 }, 5);
  const m4 = pl.enqueue({ n: 4 }, 1);
  const m5 = pl.enqueue({ n: 5 }, 9);

  const batch = pl.claim('g1', 50);
  assert.deepEqual(batch.map((c) => c.messageId), [m2, m5, m1, m3, m4]);
  assert.deepEqual(batch[0].payload, { n: 2 });
  pl.close();
  ctx.cleanup();
});

test('claim returns at most max messages and all candidates when fewer exist', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  for (let i = 0; i < 3; i++) pl.enqueue({ i }, 5);

  const first = pl.claim('g1', 2);
  assert.equal(first.length, 2);
  const second = pl.claim('g1', 50);
  assert.equal(second.length, 1);
  const third = pl.claim('g1', 50);
  assert.equal(third.length, 0);
  pl.close();
  ctx.cleanup();
});

test('claim validates max range', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  assert.throws(() => pl.claim('g1', 0), RangeError);
  assert.throws(() => pl.claim('g1', 51), RangeError);
  pl.close();
  ctx.cleanup();
});

test('redelivery keeps original enqueue order instead of moving to tail', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const m1 = pl.enqueue({ n: 1 }, 5);
  const m2 = pl.enqueue({ n: 2 }, 5);
  const m3 = pl.enqueue({ n: 3 }, 5);

  const first = pl.claim('g1', 2);
  assert.deepEqual(first.map((c) => c.messageId), [m1, m2]);
  ctx.clock.advance(30_000); // 两笔租约到期

  const second = pl.claim('g1', 50);
  assert.deepEqual(second.map((c) => c.messageId), [m1, m2, m3]);
  pl.close();
  ctx.cleanup();
});

test('competing consumers on the same group never hold overlapping valid leases', () => {
  const ctx = makeContext(['g1']);
  const plA = ctx.open();
  const plB = ctx.open(); // 同进程第二个实例，访问同一文件
  for (let i = 0; i < 20; i++) plA.enqueue({ i }, (i % 10) + 1);

  // 消费者 A 领取一批
  const batchA = plA.claim('g1', 7);
  assert.equal(batchA.length, 7);
  // 租约有效期内，B 领不到任何消息（全部候选已被 A 持有）
  const batchB = plB.claim('g1', 50);
  assert.equal(batchB.length, 13);
  const idsA = new Set(batchA.map((c) => c.messageId));
  for (const c of batchB) assert.ok(!idsA.has(c.messageId));

  // B 确认自己的，A 确认自己的，互不干扰
  for (const c of batchB) assert.ok(plB.ack('g1', c.receipt));
  for (const c of batchA) assert.ok(plA.ack('g1', c.receipt));

  // 全部确认后无剩余
  assert.equal(plA.claim('g1', 50).length, 0);
  plA.close();
  plB.close();
  ctx.cleanup();
});

test('expired lease makes message claimable again by another consumer', () => {
  const ctx = makeContext(['g1']);
  const plA = ctx.open();
  const plB = ctx.open();
  plA.enqueue({ x: 1 }, 5);

  const batchA = plA.claim('g1', 1);
  assert.equal(batchA.length, 1);
  assert.equal(plB.claim('g1', 1).length, 0); // A 持有中

  ctx.clock.advance(29_999);
  assert.equal(plB.claim('g1', 1).length, 0); // 尚未到期

  ctx.clock.advance(1); // 恰好到到期时刻：已失效
  const batchB = plB.claim('g1', 1);
  assert.equal(batchB.length, 1);
  assert.notEqual(batchB[0].receipt, batchA[0].receipt);
  plA.close();
  plB.close();
  ctx.cleanup();
});
