import test from "node:test";
import assert from "node:assert/strict";
import { DisciplineHistory, DisciplineState as S, Directive, Penalty, PenaltyId } from "../src/index.js";

/** 确定性伪随机数生成器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 独立参考实现：从周期起点逐秒完整回放。
 * 与库内的事件点段树完全不同的计算路径。
 */
function replay(
  periodStart: number,
  time: number,
  penalties: Penalty[],
  revoked: ReadonlySet<PenaltyId>,
  directives: Directive[],
): S {
  const byTime = new Map<number, Directive[]>();
  for (const d of directives) {
    const list = byTime.get(d.time);
    if (list) list.push(d);
    else byTime.set(d.time, [d]);
  }
  let state = S.None;
  for (let t = periodStart; t <= time; t++) {
    let coverage = 0;
    for (const p of penalties) {
      if (!revoked.has(p.id) && p.start <= t && t < p.end) coverage++;
    }
    if (state === S.Punishment && coverage === 0) state = S.Review;
    const todays = byTime.get(t);
    if (todays) {
      todays.sort((a, b) => a.seq - b.seq);
      for (const d of todays) {
        state = applyDirective(state, d.target, coverage);
      }
    }
  }
  return state;
}

function applyDirective(state: S, target: S, coverage: number): S {
  switch (target) {
    case S.Review:
      return state === S.None ? S.Review : state;
    case S.Punishment:
      return state === S.Review && coverage >= 1 ? S.Punishment : state;
    case S.Resolved:
      return state === S.Punishment ? S.Resolved : state;
    case S.None:
      return state === S.Resolved ? S.None : state;
  }
}

interface Case {
  periodStart: number;
  periodEnd: number;
  penalties: Penalty[];
  directives: Directive[];
}

function genCase(rand: () => number): Case {
  const periodStart = 0;
  const periodLen = 20 + Math.floor(rand() * 30);
  const periodEnd = periodStart + periodLen;
  const penaltyCount = 1 + Math.floor(rand() * 8);
  const directiveCount = Math.floor(rand() * 25);

  const penalties: Penalty[] = [];
  for (let i = 0; i < penaltyCount; i++) {
    const start = periodStart + Math.floor(rand() * (periodLen - 1));
    const end = start + 1 + Math.floor(rand() * (periodEnd - start - 1));
    penalties.push({ id: `p${i}`, start, end });
  }

  const directives: Directive[] = [];
  const targets = [S.None, S.Review, S.Punishment, S.Resolved];
  for (let i = 0; i < directiveCount; i++) {
    directives.push({
      time: periodStart + Math.floor(rand() * periodLen),
      seq: i,
      target: targets[Math.floor(rand() * 4)]!,
    });
  }
  return { periodStart, periodEnd, penalties, directives };
}

test("随机小规模资料：每次撤销与查询都与从头回放一致", () => {
  const rand = mulberry32(20261007);
  const ROUNDS = 400;
  let queryCount = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const { periodStart, periodEnd, penalties, directives } = genCase(rand);
    const h = new DisciplineHistory(periodStart, periodEnd);
    h.load({ penalties, directives });

    const revoked = new Set<PenaltyId>();
    const checkAll = () => {
      for (let t = periodStart; t < periodEnd; t++) {
        const want = replay(periodStart, t, penalties, revoked, directives);
        assert.equal(h.query(t), want, `round=${round} t=${t}`);
        queryCount++;
      }
    };

    checkAll();
    // 随机顺序撤销全部处罚，每次撤销后全量对拍
    const order = penalties.map((p) => p.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const id of order) {
      h.revokePenalty(id);
      revoked.add(id);
      checkAll();
    }
    // 重复撤销无效果
    for (const id of order) {
      assert.equal(h.revokePenalty(id), false);
    }
    checkAll();
  }
  assert.ok(queryCount > 50_000, `expected many comparisons, got ${queryCount}`);
});
