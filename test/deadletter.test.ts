import assert from "node:assert/strict";
import test from "node:test";
import { LEASE_DURATION_MS, MAX_ATTEMPTS, PipeLite } from "../src/pipelite.js";
import { FakeClock, tempDbPath } from "./helpers.js";

test("一组完成、另一组五次超时进入死信；关闭重开后结果不变", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const groups = ["fast", "slow"];
  let lite = new PipeLite({ path, groups, clock: clock.now });
  const mid = lite.enqueue({ n: 42 }, 7);

  // fast 组第一次领取即确认
  const fastReceipt = lite.claim("fast", 1)[0]!.receipt;
  assert.equal(lite.ack(fastReceipt), true);

  // slow 组连续五次领取后超时（不确认）
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const batch = lite.claim("slow", 1);
    assert.equal(batch.length, 1, `attempt ${attempt} should be claimable`);
    assert.equal(lite.status(mid)[1]!.attempts, attempt);
    clock.advance(LEASE_DURATION_MS); // 持有到期
  }
  // 第五次超时后进入死信，永久停止该组投递
  assert.equal(lite.status(mid)[1]!.state, "dead");
  assert.equal(lite.claim("slow", 1).length, 0);
  clock.advance(LEASE_DURATION_MS * 100);
  assert.equal(lite.status(mid)[1]!.state, "dead");
  assert.equal(lite.claim("slow", 1).length, 0);

  // fast 组状态不受 slow 组影响
  assert.equal(lite.status(mid)[0]!.state, "acked");
  assert.equal(lite.status(mid)[0]!.attempts, 1);

  // 正常关闭后重新打开：消息、各组状态、尝试次数保留
  lite.close();
  lite = new PipeLite({ path, groups, clock: clock.now });
  const st = lite.status(mid);
  assert.deepEqual(
    st.map((s) => [s.group, s.state, s.attempts]),
    [["fast", "acked", 1], ["slow", "dead", MAX_ATTEMPTS]],
  );
  assert.equal(lite.claim("slow", 1).length, 0);
  assert.equal(lite.claim("fast", 1).length, 0);
  lite.close();
  cleanup();
});

test("第五次投递若及时确认仍算完成", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g"], clock: clock.now });
  const mid = lite.enqueue({ n: 1 }, 5);
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    lite.claim("g", 1);
    clock.advance(LEASE_DURATION_MS);
  }
  // 第 5 次领取，到期前确认
  const receipt = lite.claim("g", 1)[0]!.receipt;
  clock.advance(LEASE_DURATION_MS - 1);
  assert.equal(lite.ack(receipt), true);
  assert.equal(lite.status(mid)[0]!.state, "acked");
  assert.equal(lite.status(mid)[0]!.attempts, MAX_ATTEMPTS);
  lite.close();
  cleanup();
});

test("未到期回执在关闭重开后仍然有效", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const groups = ["g"];
  let lite = new PipeLite({ path, groups, clock: clock.now });
  const mid = lite.enqueue({ n: 1 }, 5);
  const receipt = lite.claim("g", 1)[0]!.receipt;
  clock.advance(10_000); // 租约还剩 20 秒
  lite.close();
  // 重开：租约未到期，不能重复领取；回执仍可确认
  lite = new PipeLite({ path, groups, clock: clock.now });
  assert.equal(lite.claim("g", 1).length, 0);
  assert.equal(lite.status(mid)[0]!.state, "leased");
  assert.equal(lite.ack(receipt), true);
  assert.equal(lite.status(mid)[0]!.state, "acked");
  lite.close();
  cleanup();
});

test("重开时消费组配置不一致则报错", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["a", "b"], clock: clock.now });
  lite.close();
  assert.throws(
    () => new PipeLite({ path, groups: ["a", "c"], clock: clock.now }),
    /group config mismatch/,
  );
  cleanup();
});
