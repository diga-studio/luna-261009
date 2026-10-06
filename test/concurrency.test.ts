import assert from "node:assert/strict";
import test from "node:test";
import { LEASE_DURATION_MS, PipeLite } from "../src/pipelite.js";
import { FakeClock, tempDbPath } from "./helpers.js";

test("同进程两个实例共享同一数据：可见性与互斥", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const groups = ["g1", "g2"];
  const a = new PipeLite({ path, groups, clock: clock.now });
  const b = new PipeLite({ path, groups, clock: clock.now });

  const mid = a.enqueue({ n: 1 }, 5);
  // B 立即可见 A 入队的消息
  const batchB = b.claim("g1", 1);
  assert.equal(batchB.length, 1);
  // A 看到该消息在 g1 已被持有，不能重复领取
  assert.equal(a.claim("g1", 1).length, 0);
  // 但 A 可以独立领取 g2
  assert.equal(a.claim("g2", 1).length, 1);
  // B 确认后，两个实例都看到 acked
  assert.equal(b.ack(batchB[0]!.receipt), true);
  assert.equal(a.status(mid)[0]!.state, "acked");
  assert.equal(b.status(mid)[0]!.state, "acked");
  // 租约到期后 A 能领取 B 组未确认的消息？g2 的租约属于 A 的领取
  clock.advance(LEASE_DURATION_MS);
  const reclaim = b.claim("g2", 1);
  assert.equal(reclaim.length, 1);
  assert.equal(b.ack(reclaim[0]!.receipt), true);

  a.close();
  b.close();
  cleanup();
});

test("并发入队形成确定的先后关系", () => {
  const { path, cleanup } = tempDbPath();
  const clock = new FakeClock();
  const groups = ["g1"];
  const a = new PipeLite({ path, groups, clock: clock.now });
  const b = new PipeLite({ path, groups, clock: clock.now });
  const ids: number[] = [];
  // 两个实例交错入队，id 严格递增即确定顺序
  for (let i = 0; i < 100; i++) {
    ids.push(a.enqueue({ src: "a", i }, 5));
    ids.push(b.enqueue({ src: "b", i }, 5));
  }
  assert.deepEqual([...ids].sort((x, y) => x - y), ids);
  const batch = a.claim("g1", 50);
  assert.deepEqual(
    batch.map((m) => m.messageId),
    [...ids].sort((x, y) => x - y).slice(0, 50),
  );
  a.close();
  b.close();
  cleanup();
});
