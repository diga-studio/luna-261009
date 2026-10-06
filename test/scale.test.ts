import assert from "node:assert/strict";
import test from "node:test";
import {
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  PipeLite,
} from "../src/pipelite.js";
import type { DeliveryState } from "../src/pipelite.js";
import { FakeClock, lcg, tempDbPath } from "./helpers.js";

const MESSAGE_COUNT = 10_000;
const GROUP_COUNT = 8;
const CONSUMERS_PER_GROUP = 8;
const ROUND_MS = 300;

/** 独立模型：仅依据规则从事件流推导每个 (消息, 组) 的状态。 */
interface PairModel {
  attempts: number;
  acked: boolean;
  leaseUntil: number | null;
  token: string | null;
}

function pairKey(group: string, messageId: number): string {
  return `${group}${messageId}`;
}

test(
  "规模场景：10000 消息 × 8 组 × 每组 8 消费者，结果与独立推导一致",
  { timeout: 600_000 },
  () => {
    const { path, cleanup } = tempDbPath();
    const clock = new FakeClock();
    const groups = Array.from({ length: GROUP_COUNT }, (_, i) => `g${i}`);
    const liteA = new PipeLite({ path, groups, clock: clock.now });
    const liteB = new PipeLite({ path, groups, clock: clock.now });
    const lites = [liteA, liteB];

    // 入队 10000 条消息，优先级随机
    const rand = lcg(20261007);
    const priorities: number[] = [];
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      const p = 1 + Math.floor(rand() * 10);
      priorities.push(p);
      const id = liteA.enqueue({ seq: i, p }, p);
      assert.equal(id, i + 1);
    }

    const models = new Map<string, PairModel>();
    const modelFor = (group: string, messageId: number): PairModel => {
      const key = pairKey(group, messageId);
      let m = models.get(key);
      if (m === undefined) {
        m = { attempts: 0, acked: false, leaseUntil: null, token: null };
        models.set(key, m);
      }
      return m;
    };

    // 消费者状态：持有待确认或永不确认的回执
    interface Held {
      token: string;
      messageId: number;
      group: string;
      ackAt: number | null; // null = 永不确认
    }
    interface Consumer {
      group: string;
      lite: PipeLite;
      rand: () => number;
      held: Held[];
    }
    const consumers: Consumer[] = [];
    for (let g = 0; g < GROUP_COUNT; g++) {
      for (let c = 0; c < CONSUMERS_PER_GROUP; c++) {
        consumers.push({
          group: groups[g]!,
          lite: lites[(g + c) % 2]!,
          rand: lcg(1000 + g * 100 + c),
          held: [],
        });
      }
    }

    let acceptedAcks = 0;
    let rounds = 0;
    const maxRounds = 20_000;
    const totalPairs = MESSAGE_COUNT * GROUP_COUNT;

    // 统计已终结（acked 或 dead）的 (消息, 组) 对数，用于收敛判断
    const countTerminal = (now: number): number => {
      let terminal = 0;
      for (const m of models.values()) {
        if (m.acked) terminal++;
        else if (
          m.attempts >= MAX_ATTEMPTS &&
          (m.leaseUntil === null || m.leaseUntil <= now)
        ) {
          terminal++;
        }
      }
      return terminal;
    };

    while (rounds < maxRounds) {
      rounds++;
      clock.advance(ROUND_MS);
      const now = clock.now();

      for (const consumer of consumers) {
        // 1) 执行到期的计划确认（部分被安排成迟到确认）
        const stillHeld: Held[] = [];
        for (const held of consumer.held) {
          if (held.ackAt !== null && held.ackAt <= now) {
            const model = modelFor(held.group, held.messageId);
            const expected =
              !model.acked && model.token === held.token &&
              model.leaseUntil !== null && model.leaseUntil > now;
            const actual = consumer.lite.ack({
              messageId: held.messageId,
              group: held.group,
              token: held.token,
              expiresAt: 0, // expiresAt 仅为回执携带信息，服务端以存储为准
            });
            assert.equal(actual, expected, "ack 结果必须与模型推导一致");
            if (actual) {
              model.acked = true;
              model.token = null;
              model.leaseUntil = null;
              acceptedAcks++;
            }
          } else {
            stillHeld.push(held);
          }
        }
        consumer.held = stillHeld;

        // 2) 领取一批
        const limit = 1 + Math.floor(consumer.rand() * 50);
        const batch = consumer.lite.claim(consumer.group, limit);

        // 批次内必须符合 优先级降序、同优先级按入队先后
        for (let i = 1; i < batch.length; i++) {
          const prev = batch[i - 1]!;
          const curr = batch[i]!;
          const ordered =
            curr.priority < prev.priority ||
            (curr.priority === prev.priority && curr.messageId > prev.messageId);
          assert.ok(ordered, "批次内顺序必须遵守优先级与入队顺序");
        }

        for (const item of batch) {
          const model = modelFor(consumer.group, item.messageId);
          // 模型断言：该消息此刻必须可领取（无有效期重叠的重复领取）
          assert.ok(!model.acked, "已确认消息不能再被领取");
          assert.ok(model.attempts < MAX_ATTEMPTS, "死信消息不能再被领取");
          assert.ok(
            model.leaseUntil === null || model.leaseUntil <= now,
            `同组同消息不得有有效期重叠的重复领取 (mid=${item.messageId})`,
          );
          assert.equal(item.priority, priorities[item.messageId - 1]);
          model.attempts++;
          model.leaseUntil = now + LEASE_DURATION_MS;
          model.token = item.receipt.token;

          // 决定该回执命运：70% 立即确认，20% 稍后（可能迟到），10% 永不
          const roll = consumer.rand();
          if (roll < 0.7) {
            const actual = consumer.lite.ack(item.receipt);
            assert.ok(actual, "立即确认必须成功");
            model.acked = true;
            model.token = null;
            model.leaseUntil = null;
            acceptedAcks++;
          } else if (roll < 0.9) {
            // 10~50 秒后确认：超过 30 秒租约的即为迟到确认
            const ackAt = now + 10_000 + Math.floor(consumer.rand() * 40_000);
            consumer.held.push({
              token: item.receipt.token,
              messageId: item.messageId,
              group: consumer.group,
              ackAt,
            });
          } else {
            consumer.held.push({
              token: item.receipt.token,
              messageId: item.messageId,
              group: consumer.group,
              ackAt: null,
            });
          }
        }
      }

      // 每 10 轮检查一次是否全部终结（acked 或 dead）
      if (rounds % 10 === 0 && countTerminal(clock.now()) === totalPairs) break;
    }

    // 独立推导最终状态并与内核 status 逐一比对
    const finalNow = clock.now();
    let ackedCount = 0;
    let deadCount = 0;
    for (let mid = 1; mid <= MESSAGE_COUNT; mid++) {
      const statuses = liteA.status(mid);
      for (const group of groups) {
        const model = modelFor(group, mid);
        let expected: DeliveryState;
        if (model.acked) expected = "acked";
        else if (model.leaseUntil !== null && model.leaseUntil > finalNow) {
          expected = "leased";
        } else if (model.attempts >= MAX_ATTEMPTS) expected = "dead";
        else expected = "pending";
        const actual = statuses.find((s) => s.group === group)!;
        assert.equal(
          actual.state,
          expected,
          `mid=${mid} group=${group} 状态与独立推导不一致`,
        );
        assert.equal(actual.attempts, model.attempts, "尝试次数必须一致");
        if (expected === "acked") ackedCount++;
        if (expected === "dead") deadCount++;
      }
    }
    // 全部终结：不存在永远悬挂的消息
    assert.equal(ackedCount + deadCount, MESSAGE_COUNT * GROUP_COUNT);
    assert.ok(ackedCount > 0);
    assert.ok(rounds < maxRounds, "场景必须收敛");

    liteA.close();
    liteB.close();
    cleanup();
  },
);
