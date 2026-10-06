import assert from "node:assert/strict";
import test from "node:test";
import { PipeLite } from "../src/pipelite.js";
import { FakeClock, tempDbPath } from "./helpers.js";

test("enqueue 校验优先级与载荷", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g1"], clock: clock.now });
  assert.throws(() => lite.enqueue({ a: 1 }, 0), RangeError);
  assert.throws(() => lite.enqueue({ a: 1 }, 11), RangeError);
  assert.throws(() => lite.enqueue({ a: 1 }, 2.5), RangeError);
  assert.throws(() => lite.enqueue(undefined, 5), TypeError);
  const id = lite.enqueue({ a: 1 }, 5);
  assert.equal(id, 1);
  lite.close();
  cleanup();
});

test("消费组数量与名称校验", () => {
  const { path, cleanup } = tempDbPath();
  assert.throws(() => new PipeLite({ path, groups: [] }), RangeError);
  assert.throws(
    () => new PipeLite({ path, groups: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }),
    RangeError,
  );
  assert.throws(() => new PipeLite({ path, groups: ["a", "a"] }), Error);
  cleanup();
});

test("领取按优先级降序、同优先级按入队先后", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g1"], clock: clock.now });
  const m1 = lite.enqueue({ n: 1 }, 3);
  const m2 = lite.enqueue({ n: 2 }, 9);
  const m3 = lite.enqueue({ n: 3 }, 9);
  const m4 = lite.enqueue({ n: 4 }, 1);
  const batch = lite.claim("g1", 10);
  assert.deepEqual(batch.map((m) => m.messageId), [m2, m3, m1, m4]);
  assert.deepEqual(batch[0]?.payload, { n: 2 });
  lite.close();
  cleanup();
});

test("候选不足时返回全部候选；已确认消息不再被领取", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g1"], clock: clock.now });
  lite.enqueue({ n: 1 }, 5);
  lite.enqueue({ n: 2 }, 5);
  const first = lite.claim("g1", 50);
  assert.equal(first.length, 2);
  // 租约未到期，不能再领
  assert.equal(lite.claim("g1", 50).length, 0);
  const r0 = first[0]!.receipt;
  assert.equal(lite.ack(r0), true);
  clock.advance(31_000);
  // 只剩未确认的那条可领
  const second = lite.claim("g1", 50);
  assert.deepEqual(second.map((m) => m.messageId), [first[1]!.messageId]);
  lite.close();
  cleanup();
});

test("重新投递保留原入队顺序，不被放到队尾", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g1"], clock: clock.now });
  const m1 = lite.enqueue({ n: 1 }, 5);
  const m2 = lite.enqueue({ n: 2 }, 5);
  // 领走 m1 但不确认，随后入队 m3
  const first = lite.claim("g1", 1);
  assert.equal(first[0]!.messageId, m1);
  const m3 = lite.enqueue({ n: 3 }, 5);
  clock.advance(31_000);
  // m1 过期重新可领，且排在 m2、m3 之前（原入队顺序）
  const batch = lite.claim("g1", 10);
  assert.deepEqual(batch.map((m) => m.messageId), [m1, m2, m3]);
  lite.close();
  cleanup();
});

test("各消费组状态互不影响", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["ga", "gb"], clock: clock.now });
  const mid = lite.enqueue({ n: 1 }, 5);
  const a = lite.claim("ga", 1);
  assert.equal(lite.ack(a[0]!.receipt), true);
  // ga 已确认，gb 仍可独立领取
  assert.equal(lite.claim("ga", 1).length, 0);
  const b = lite.claim("gb", 1);
  assert.equal(b.length, 1);
  assert.equal(b[0]!.receipt.group, "gb");
  const st = lite.status(mid);
  assert.deepEqual(
    st.map((s) => [s.group, s.state, s.attempts]),
    [["ga", "acked", 1], ["gb", "leased", 1]],
  );
  lite.close();
  cleanup();
});

test("claim 参数校验", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const lite = new PipeLite({ path, groups: ["g1"], clock: clock.now });
  lite.enqueue({ n: 1 }, 5);
  assert.throws(() => lite.claim("nope", 1), Error);
  assert.throws(() => lite.claim("g1", 0), RangeError);
  assert.throws(() => lite.claim("g1", 51), RangeError);
  assert.throws(() => lite.ack({ bad: true }), TypeError);
  lite.close();
  cleanup();
});
