import test from "node:test";
import assert from "node:assert/strict";
import { DisciplineHistory, DisciplineState as S, Directive, Penalty } from "../src/index.js";

function makeHistory(
  penalties: Penalty[],
  directives: Directive[],
  periodStart = 0,
  periodEnd = 1000,
): DisciplineHistory {
  const h = new DisciplineHistory(periodStart, periodEnd);
  h.load({ penalties, directives });
  return h;
}

test("周期开始状态为无处分", () => {
  const h = makeHistory([], []);
  assert.equal(h.query(0), S.None);
  assert.equal(h.query(999), S.None);
});

test("人工转换链完整推进", () => {
  const h = makeHistory(
    [{ id: "p1", start: 0, end: 100 }],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 2, seq: 2, target: S.Punishment },
      { time: 3, seq: 3, target: S.Resolved },
      { time: 4, seq: 4, target: S.None },
    ],
  );
  assert.equal(h.query(0), S.None);
  assert.equal(h.query(1), S.Review);
  assert.equal(h.query(2), S.Punishment);
  assert.equal(h.query(3), S.Resolved);
  assert.equal(h.query(4), S.None);
  assert.equal(h.query(500), S.None);
});

test("不满足前提的指令保留但被忽略", () => {
  const h = makeHistory(
    [{ id: "p1", start: 0, end: 100 }],
    [
      { time: 1, seq: 1, target: S.Punishment }, // 无处分 -> 处分中 不允许
      { time: 2, seq: 2, target: S.Resolved }, // 不在处分中
      { time: 3, seq: 3, target: S.None }, // 不在已解决
      { time: 4, seq: 4, target: S.Review }, // 允许
      { time: 5, seq: 5, target: S.Review }, // 重复，忽略
    ],
  );
  assert.equal(h.query(3), S.None);
  assert.equal(h.query(4), S.Review);
  assert.equal(h.query(5), S.Review);
});

test("进入处分中要求该秒有有效处罚覆盖", () => {
  const h = makeHistory(
    [{ id: "p1", start: 10, end: 20 }],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 5, seq: 2, target: S.Punishment }, // 覆盖未开始，忽略
      { time: 15, seq: 3, target: S.Punishment }, // 覆盖中，生效
      { time: 25, seq: 4, target: S.Resolved }, // 覆盖已结束但状态转移不看覆盖
    ],
  );
  assert.equal(h.query(5), S.Review);
  assert.equal(h.query(14), S.Review);
  assert.equal(h.query(15), S.Punishment);
  // 覆盖在 20 结束，处分中自动降级为审查中
  assert.equal(h.query(20), S.Review);
  assert.equal(h.query(25), S.Review);
});

test("覆盖归零自动回到审查中，恢复覆盖不自动升级", () => {
  const h = makeHistory(
    [
      { id: "p1", start: 0, end: 10 },
      { id: "p2", start: 20, end: 30 },
    ],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 2, seq: 2, target: S.Punishment },
    ],
  );
  assert.equal(h.query(9), S.Punishment);
  assert.equal(h.query(10), S.Review); // 覆盖降到零，自动降级
  assert.equal(h.query(19), S.Review);
  assert.equal(h.query(25), S.Review); // 覆盖恢复，不自动升级
  assert.equal(h.query(29), S.Review);
});

test("首尾相接的处罚不产生瞬间空档", () => {
  const h = makeHistory(
    [
      { id: "p1", start: 0, end: 10 },
      { id: "p2", start: 10, end: 20 },
      { id: "p3", start: 20, end: 30 },
    ],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 2, seq: 2, target: S.Punishment },
    ],
  );
  for (const t of [9, 10, 11, 19, 20, 21, 29]) {
    assert.equal(h.query(t), S.Punishment, `t=${t}`);
  }
  assert.equal(h.query(30), S.Review);
});

test("同一秒多条指令按序号升序处理", () => {
  const h = makeHistory(
    [{ id: "p1", start: 0, end: 100 }],
    [
      { time: 5, seq: 3, target: S.Resolved },
      { time: 5, seq: 1, target: S.Review },
      { time: 5, seq: 2, target: S.Punishment },
    ],
  );
  assert.equal(h.query(4), S.None);
  assert.equal(h.query(5), S.Resolved);
});

test("同一秒自动转换先于人工指令", () => {
  // 覆盖在 10 结束；10 秒时先自动降级，之后的处分中指令因无覆盖被忽略
  const h = makeHistory(
    [{ id: "p1", start: 0, end: 10 }],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 2, seq: 2, target: S.Punishment },
      { time: 10, seq: 3, target: S.Punishment }, // 无覆盖，忽略
      { time: 10, seq: 4, target: S.Resolved }, // 状态已是审查中，忽略
    ],
  );
  assert.equal(h.query(10), S.Review);
});

test("装载顺序不影响结果", () => {
  const penalties: Penalty[] = [
    { id: "a", start: 0, end: 7 },
    { id: "b", start: 7, end: 60 },
    { id: "c", start: 30, end: 90 },
  ];
  const directives: Directive[] = [
    { time: 1, seq: 1, target: S.Review },
    { time: 2, seq: 2, target: S.Punishment },
    { time: 65, seq: 3, target: S.Resolved },
    { time: 70, seq: 4, target: S.None },
  ];
  const h1 = makeHistory(penalties, directives);
  const h2 = makeHistory([...penalties].reverse(), [...directives].reverse());
  for (const t of [0, 1, 2, 7, 59, 60, 65, 70, 89, 90, 99]) {
    assert.equal(h1.query(t), h2.query(t), `t=${t}`);
  }
});

test("撤销唯一早期支撑处罚后，后续指令被重新判定", () => {
  const h = makeHistory(
    [{ id: "sole", start: 0, end: 100 }],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 2, seq: 2, target: S.Punishment },
      { time: 3, seq: 3, target: S.Resolved },
      { time: 4, seq: 4, target: S.None },
      { time: 5, seq: 5, target: S.Review },
      { time: 6, seq: 6, target: S.Punishment },
    ],
  );
  assert.equal(h.query(6), S.Punishment);
  assert.equal(h.query(99), S.Punishment);

  assert.equal(h.revokePenalty("sole"), true);
  // 更正后：处分中指令失去前提，后续已解决/无处分/处分中连锁失效
  assert.equal(h.query(1), S.Review);
  assert.equal(h.query(2), S.Review);
  assert.equal(h.query(3), S.Review);
  assert.equal(h.query(4), S.Review);
  assert.equal(h.query(5), S.Review);
  assert.equal(h.query(6), S.Review);
  assert.equal(h.query(99), S.Review);
});

test("撤销后以前忽略的指令可能重新生效", () => {
  const directives: Directive[] = [
    { time: 1, seq: 1, target: S.Review },
    { time: 2, seq: 2, target: S.Punishment }, // p1 支撑
    { time: 3, seq: 3, target: S.Resolved },
    { time: 4, seq: 4, target: S.None },
    { time: 25, seq: 5, target: S.Punishment }, // 原历史：状态为无处分，忽略
    { time: 26, seq: 6, target: S.Review },
    { time: 27, seq: 7, target: S.Punishment },
  ];
  const penalties: Penalty[] = [
    { id: "p1", start: 0, end: 10 },
    { id: "p2", start: 20, end: 30 },
  ];
  const h = makeHistory(penalties, directives);
  assert.equal(h.query(25), S.None); // seq=5 被忽略
  assert.equal(h.query(26), S.Review);
  assert.equal(h.query(27), S.Punishment);

  assert.equal(h.revokePenalty("p1"), true);
  // 更正后：seq=2 失效，状态停在审查中；seq=5 此刻反而满足前提
  assert.equal(h.query(4), S.Review);
  assert.equal(h.query(25), S.Punishment);
  assert.equal(h.query(26), S.Punishment); // seq=6 此时被忽略
  assert.equal(h.query(27), S.Punishment);
});

test("撤销部分覆盖后仍在处分中，不触发自动降级", () => {
  const h = makeHistory(
    [
      { id: "p1", start: 0, end: 100 },
      { id: "p2", start: 0, end: 100 },
    ],
    [
      { time: 1, seq: 1, target: S.Review },
      { time: 2, seq: 2, target: S.Punishment },
    ],
  );
  assert.equal(h.revokePenalty("p1"), true);
  assert.equal(h.query(50), S.Punishment); // p2 仍覆盖
  assert.equal(h.revokePenalty("p2"), true);
  assert.equal(h.query(50), S.Review); // 覆盖归零，自动降级
});

test("重复撤销与未知编号无额外效果", () => {
  const h = makeHistory([{ id: "p1", start: 0, end: 10 }], []);
  assert.equal(h.revokePenalty("nope"), false);
  assert.equal(h.revokePenalty("p1"), true);
  assert.equal(h.revokePenalty("p1"), false);
  assert.equal(h.query(5), S.None);
});

test("非法输入被拒绝", () => {
  assert.throws(() => new DisciplineHistory(10, 10), RangeError);
  assert.throws(() => new DisciplineHistory(10, 0), RangeError);

  const h1 = new DisciplineHistory(0, 100);
  assert.throws(
    () => h1.load({ penalties: [{ id: "x", start: -1, end: 5 }], directives: [] }),
    RangeError,
  );

  const h2 = new DisciplineHistory(0, 100);
  assert.throws(
    () =>
      h2.load({
        penalties: [
          { id: "x", start: 0, end: 5 },
          { id: "x", start: 6, end: 9 },
        ],
        directives: [],
      }),
    /duplicate penalty id/,
  );

  const h3 = new DisciplineHistory(0, 100);
  assert.throws(
    () =>
      h3.load({
        penalties: [],
        directives: [
          { time: 1, seq: 1, target: S.Review },
          { time: 2, seq: 1, target: S.Review },
        ],
      }),
    /duplicate directive seq/,
  );

  const h4 = new DisciplineHistory(0, 100);
  assert.throws(
    () => h4.load({ penalties: [], directives: [{ time: 100, seq: 1, target: S.Review }] }),
    RangeError,
  );
});

test("重复装载与未装载查询被拒绝", () => {
  const h = new DisciplineHistory(0, 100);
  assert.throws(() => h.query(0), /not loaded/);
  h.load({ penalties: [], directives: [] });
  assert.throws(() => h.load({ penalties: [], directives: [] }), /already loaded/);
  assert.throws(() => h.query(-1), RangeError);
  assert.throws(() => h.query(100), RangeError);
});
