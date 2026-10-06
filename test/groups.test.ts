import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { makeContext, GROUPS8 } from './helpers';

test('one group acks while another goes dead after five timeouts; states independent', () => {
  const ctx = makeContext(['g1', 'g2']);
  const pl = ctx.open();
  const id = pl.enqueue({ job: 'x' }, 7);

  // g1：领取并及时确认
  const [c] = pl.claim('g1', 1);
  assert.ok(pl.ack('g1', c.receipt));

  // g2：连续五次领取后都超时
  for (let round = 1; round <= 5; round++) {
    const batch = pl.claim('g2', 1);
    assert.equal(batch.length, 1, `round ${round} should deliver`);
    ctx.clock.advance(30_000); // 不确认，放任超时
  }

  const st = pl.status(id);
  assert.deepEqual(
    st.map((s) => [s.group, s.state, s.attempts]),
    [
      ['g1', 'acked', 1],
      ['g2', 'dead', 5],
    ],
  );
  // 死信后永久停止该组投递
  assert.equal(pl.claim('g2', 50).length, 0);
  pl.close();
  ctx.cleanup();
});

test('fifth delivery acked in time still completes', () => {
  const ctx = makeContext(['g1']);
  const pl = ctx.open();
  const id = pl.enqueue({ job: 'y' }, 3);

  for (let round = 1; round <= 4; round++) {
    pl.claim('g1', 1);
    ctx.clock.advance(30_000);
  }
  const [fifth] = pl.claim('g1', 1);
  ctx.clock.advance(29_999);
  assert.ok(pl.ack('g1', fifth.receipt));
  const st = pl.status(id);
  assert.equal(st[0].state, 'acked');
  assert.equal(st[0].attempts, 5);
  pl.close();
  ctx.cleanup();
});

test('group state, attempts and live receipts survive close and reopen', () => {
  const ctx = makeContext(['g1', 'g2']);
  let pl = ctx.open();
  const id1 = pl.enqueue({ n: 1 }, 5);
  const id2 = pl.enqueue({ n: 2 }, 5);

  // g1 确认 id1；g2 对 id1 超时两次；id2 被 g1 持有一个未到期回执
  const [a] = pl.claim('g1', 2);
  assert.ok(pl.ack('g1', a.receipt));
  pl.claim('g2', 2);
  ctx.clock.advance(30_000);
  pl.claim('g2', 2);
  ctx.clock.advance(30_000);
  const [live] = pl.claim('g1', 1); // id2 在 g1 的未到期回执
  assert.equal(live.messageId, id2);
  pl.close();

  // 不重推进时钟：未到期回执必须保留
  pl = ctx.open();
  let st = pl.status(id1);
  assert.deepEqual(
    st.map((s) => [s.group, s.state, s.attempts]),
    [
      ['g1', 'acked', 1],
      ['g2', 'pending', 2],
    ],
  );
  // id2 在 g1 仍被原回执持有，重开后领不到
  assert.equal(pl.claim('g1', 50).length, 0);
  // 但原回执仍然有效，可以确认
  assert.ok(pl.ack('g1', live.receipt));
  st = pl.status(id2);
  assert.equal(st[0].state, 'acked');
  // g2 仍可独立领取：id1、id2 在 g2 都还是 pending
  const rest = pl.claim('g2', 50);
  assert.deepEqual(rest.map((c) => c.messageId).sort(), [id1, id2].sort());
  pl.close();
  ctx.cleanup();
});

test('dead state persists across reopen', () => {
  const ctx = makeContext(['g1']);
  let pl = ctx.open();
  const id = pl.enqueue({ n: 1 }, 5);
  for (let round = 1; round <= 5; round++) {
    pl.claim('g1', 1);
    ctx.clock.advance(30_000);
  }
  assert.equal(pl.status(id)[0].state, 'dead');
  pl.close();

  pl = ctx.open();
  const st = pl.status(id);
  assert.equal(st[0].state, 'dead');
  assert.equal(st[0].attempts, 5);
  assert.equal(pl.claim('g1', 50).length, 0);
  pl.close();
  ctx.cleanup();
});

test('groups are fixed at init: 1 to 8, validated, persisted', () => {
  const ctx = makeContext(GROUPS8);
  const pl = ctx.open(GROUPS8);
  pl.enqueue({ n: 1 }, 5);
  assert.equal(pl.status(1).length, 8);
  pl.close();

  // 重新打开时组列表不一致则报错
  assert.throws(() => ctx.open(['g1', 'g2']), /groups/);
  // 非法组配置
  assert.throws(() => ctx.open([]), RangeError);
  assert.throws(() => ctx.open(['a', 'a']), /unique/);
  const tooMany = [...GROUPS8, 'g9'];
  assert.throws(() => ctx.open(tooMany), RangeError);
  ctx.cleanup();
});

test('a stuck consumer does not block the rest of its group or other groups', () => {
  const ctx = makeContext(['g1', 'g2']);
  const plStuck = ctx.open();
  const plWork = ctx.open();
  for (let i = 0; i < 10; i++) plWork.enqueue({ i }, 5);

  // “卡住”的消费者领走 1 条永不确认
  const stuck = plStuck.claim('g1', 1);
  assert.equal(stuck.length, 1);

  // 同组其他消费者照常领取并确认其余消息
  const rest = plWork.claim('g1', 50);
  assert.equal(rest.length, 9);
  for (const c of rest) assert.ok(plWork.ack('g1', c.receipt));

  // 其他组照常推进
  const other = plWork.claim('g2', 50);
  assert.equal(other.length, 10);
  for (const c of other) assert.ok(plWork.ack('g2', c.receipt));

  // 卡住的那条超时后仍能被本组重新领取
  ctx.clock.advance(30_000);
  const redelivered = plWork.claim('g1', 50);
  assert.equal(redelivered.length, 1);
  assert.equal(redelivered[0].messageId, stuck[0].messageId);
  plStuck.close();
  plWork.close();
  ctx.cleanup();
});
