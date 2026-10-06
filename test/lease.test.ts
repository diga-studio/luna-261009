import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { makeContext } from './helpers';

test('ack within lease confirms; ack at exact expiry moment fails', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  pl.enqueue({ a: 1 }, 5);
  pl.enqueue({ b: 2 }, 5);
  const [c1, c2] = pl.claim('g1', 2);

  ctx.clock.advance(29_999); // 有效期最后一毫秒
  assert.ok(pl.ack('g1', c1.receipt));

  ctx.clock.advance(1); // 恰好到期时刻：已失效
  assert.ok(!pl.ack('g1', c2.receipt));

  const st = pl.status(c2.messageId);
  assert.equal(st[0].state, 'pending');
  assert.equal(st[0].attempts, 1);
  pl.close();
  ctx.cleanup();
});

test('late ack after expiry is invalid even if nobody re-claimed', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const id = pl.enqueue({ a: 1 }, 5);
  const [c] = pl.claim('g1', 1);

  ctx.clock.advance(60_000); // 早已过期，无人重新领取
  assert.ok(!pl.ack('g1', c.receipt));
  const st = pl.status(id);
  assert.equal(st[0].state, 'pending');
  pl.close();
  ctx.cleanup();
});

test('old receipt cannot confirm, extend, or alter attempts of a new delivery', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const id = pl.enqueue({ a: 1 }, 5);

  const first = pl.claim('g1', 1)[0];
  ctx.clock.advance(30_000); // 第一次投递过期
  const second = pl.claim('g1', 1)[0]; // 重新领取，attempts = 2
  assert.notEqual(first.receipt, second.receipt);

  // 旧回执不能确认新投递
  assert.ok(!pl.ack('g1', first.receipt));
  let st = pl.status(id);
  assert.equal(st[0].state, 'leased');
  assert.equal(st[0].attempts, 2);

  // 旧回执也没有延长新投递的有效期：新回执在原定 30s 后失效
  ctx.clock.advance(30_000);
  assert.ok(!pl.ack('g1', second.receipt));
  st = pl.status(id);
  assert.equal(st[0].state, 'pending');
  assert.equal(st[0].attempts, 2);
  pl.close();
  ctx.cleanup();
});

test('new receipt still confirms normally after old receipt interleaving', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const id = pl.enqueue({ a: 1 }, 5);

  const first = pl.claim('g1', 1)[0];
  ctx.clock.advance(30_000);
  const second = pl.claim('g1', 1)[0];

  assert.ok(!pl.ack('g1', first.receipt)); // 迟到确认无效
  assert.ok(pl.ack('g1', second.receipt)); // 新回执正常确认
  const st = pl.status(id);
  assert.equal(st[0].state, 'acked');
  assert.equal(st[0].attempts, 2);
  pl.close();
  ctx.cleanup();
});

test('duplicate ack has no extra effect', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const id = pl.enqueue({ a: 1 }, 5);
  const [c] = pl.claim('g1', 1);

  assert.ok(pl.ack('g1', c.receipt));
  assert.ok(!pl.ack('g1', c.receipt)); // 重复确认
  const st = pl.status(id);
  assert.equal(st[0].state, 'acked');
  assert.equal(st[0].attempts, 1);
  // 已确认的消息不能再被领取
  assert.equal(pl.claim('g1', 50).length, 0);
  pl.close();
  ctx.cleanup();
});

test('ack with unknown or foreign-group receipt fails', () => {
  const ctx = makeContext(['g1', 'g2']);
  const pl = ctx.open();
  pl.enqueue({ a: 1 }, 5);
  const [c] = pl.claim('g1', 1);

  assert.ok(!pl.ack('g1', 'totally-bogus-receipt'));
  assert.throws(() => pl.ack('no-such-group', c.receipt));
  // g2 的领取与 g1 的回执互不相干
  const [c2] = pl.claim('g2', 1);
  assert.ok(!pl.ack('g1', c2.receipt));
  assert.ok(pl.ack('g2', c2.receipt));
  assert.ok(pl.ack('g1', c.receipt));
  pl.close();
  ctx.cleanup();
});
