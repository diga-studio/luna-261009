import assert from "node:assert/strict";
import test from "node:test";
import { LEASE_DURATION_MS, PipeLite } from "../src/pipelite.js";
import type { Receipt } from "../src/pipelite.js";
import { FakeClock, tempDbPath } from "./helpers.js";

function setup() {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g1", "g2"], clock: clock.now });
  return { lite, clock, cleanup };
}

test("租约 30 秒：到期前同组不能再领，其他组不受影响", () => {
  const { lite, clock, cleanup } = setup();
  const mid = lite.enqueue({ n: 1 }, 5);
  const t0 = clock.now();
  const first = lite.claim("g1", 1);
  assert.equal(first[0]!.receipt.expiresAt, t0 + LEASE_DURATION_MS);
  // 到期前 1ms 仍被持有
  clock.set(t0 + LEASE_DURATION_MS - 1);
  assert.equal(lite.claim("g1", 1).length, 0);
  // 其他组可独立领取
  assert.equal(lite.claim("g2", 1).length, 1);
  // 到期时刻本身已失效，可重新领取
  clock.set(t0 + LEASE_DURATION_MS);
  const second = lite.claim("g1", 1);
  assert.equal(second.length, 1);
  assert.equal(second[0]!.messageId, mid);
  lite.close();
  cleanup();
});

test("到期边界上的确认：前 1ms 有效，到期时刻无效", () => {
  const { lite, clock, cleanup } = setup();
  lite.enqueue({ n: 1 }, 5);
  const t0 = clock.now();
  const r1 = lite.claim("g1", 1)[0]!.receipt;
  // 到期时刻 ack 无效（即使尚未有人重新领取）
  clock.set(t0 + LEASE_DURATION_MS);
  assert.equal(lite.ack(r1), false);
  assert.equal(lite.status(1)[0]!.state, "pending");
  // 重新领取，新回执在到期前 1ms 确认有效
  const r2 = lite.claim("g1", 1)[0]!.receipt;
  clock.set(r2.expiresAt - 1);
  assert.equal(lite.ack(r2), true);
  assert.equal(lite.status(1)[0]!.state, "acked");
  lite.close();
  cleanup();
});

test("旧回执不能确认新投递、不能延长有效期、不改变尝试次数", () => {
  const { lite, clock, cleanup } = setup();
  const mid = lite.enqueue({ n: 1 }, 5);
  const r1 = lite.claim("g1", 1)[0]!.receipt;
  clock.advance(LEASE_DURATION_MS);
  const r2 = lite.claim("g1", 1)[0]!.receipt;
  const attemptsBefore = lite.status(mid)[0]!.attempts;
  // 旧回执确认新投递：无效
  assert.equal(lite.ack(r1), false);
  const st = lite.status(mid)[0]!;
  assert.equal(st.state, "leased");
  assert.equal(st.attempts, attemptsBefore);
  assert.equal(st.leaseExpiresAt, r2.expiresAt);
  // 旧回执过期后再试，依然无效
  clock.advance(LEASE_DURATION_MS + 1);
  assert.equal(lite.ack(r1), false);
  // 新回执已过期也无效；第三次领取后确认成功
  assert.equal(lite.ack(r2), false);
  const r3 = lite.claim("g1", 1)[0]!.receipt;
  assert.equal(lite.ack(r3), true);
  assert.equal(lite.status(mid)[0]!.state, "acked");
  assert.equal(lite.status(mid)[0]!.attempts, 3);
  lite.close();
  cleanup();
});

test("重复确认不产生额外状态变化", () => {
  const { lite, clock, cleanup } = setup();
  const mid = lite.enqueue({ n: 1 }, 5);
  const receipt: Receipt = lite.claim("g1", 1)[0]!.receipt;
  assert.equal(lite.ack(receipt), true);
  assert.equal(lite.ack(receipt), false);
  clock.advance(LEASE_DURATION_MS * 2);
  assert.equal(lite.ack(receipt), false);
  // 已确认消息不会被再次领取，重复确认没有副作用
  assert.equal(lite.claim("g1", 1).length, 0);
  assert.deepEqual(lite.status(mid)[0], {
    group: "g1",
    state: "acked",
    attempts: 1,
    leaseExpiresAt: null,
  });
  lite.close();
  cleanup();
});

test("回执跨组无效", () => {
  const { lite, cleanup } = setup();
  lite.enqueue({ n: 1 }, 5);
  const r1 = lite.claim("g1", 1)[0]!.receipt;
  const forged: Receipt = { ...r1, group: "g2" };
  assert.equal(lite.ack(forged), false);
  assert.equal(lite.status(1)[1]!.state, "pending");
  // 原回执仍有效
  assert.equal(lite.ack(r1), true);
  lite.close();
  cleanup();
});
