import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { prepare, save, open, FunnelAnalyzer, FunnelEvent, StageCounts } from "../src/index";
import { bruteForce } from "./brute";

function ev(
  customer: string,
  journey: string,
  action: string,
  time: number,
  seq: number,
): FunnelEvent {
  return { customer, journey, action, time, seq };
}

function queryAll(analyzer: FunnelAnalyzer, windows: [number, number][]): StageCounts[] {
  return windows.map(([s, e]) => analyzer.query(s, e));
}

test("同毫秒事件按序号排序完成阶段", () => {
  // 同一毫秒，序号决定先后：click(1) 在 impression(2) 之前，不能用于后续阶段
  const events = [
    ev("c1", "j1", "click", 1000, 1),
    ev("c1", "j1", "impression", 1000, 2),
    ev("c1", "j1", "click", 1000, 3),
    ev("c1", "j1", "conversion", 1000, 4),
  ];
  const a = new FunnelAnalyzer(prepare(events));
  assert.deepEqual(a.query(1000, 1001), [1, 1, 0, 0]);
  // 完整链路：同毫秒按序号依次完成全部 4 阶段
  const events2 = [
    ev("c1", "j1", "impression", 1000, 1),
    ev("c1", "j1", "click", 1000, 2),
    ev("c1", "j1", "click", 1000, 3),
    ev("c1", "j1", "conversion", 1000, 4),
  ];
  const a2 = new FunnelAnalyzer(prepare(events2));
  assert.deepEqual(a2.query(1000, 1001), [1, 1, 1, 1]);
});

test("两个 click 阶段不能使用同一个事件", () => {
  const events = [
    ev("c1", "j1", "impression", 100, 1),
    ev("c1", "j1", "click", 200, 1),
    ev("c1", "j1", "conversion", 300, 1),
  ];
  const a = new FunnelAnalyzer(prepare(events));
  assert.deepEqual(a.query(100, 301), [1, 1, 0, 0]);
});

test("窗口截掉前置动作则不能完成", () => {
  const events = [
    ev("c1", "j1", "impression", 100, 1),
    ev("c1", "j1", "click", 200, 1),
    ev("c1", "j1", "click", 300, 1),
    ev("c1", "j1", "conversion", 400, 1),
  ];
  const a = new FunnelAnalyzer(prepare(events));
  // impression 在窗口外
  assert.deepEqual(a.query(101, 401), [0, 0, 0, 0]);
  // 左闭：impression 恰好在左端点，包含
  assert.deepEqual(a.query(100, 401), [1, 1, 1, 1]);
  // 右开：conversion 恰好在右端点，排除
  assert.deepEqual(a.query(100, 400), [1, 1, 1, 0]);
  // 空窗口
  assert.deepEqual(a.query(200, 200), [0, 0, 0, 0]);
  assert.deepEqual(a.query(300, 100), [0, 0, 0, 0]);
});

test("同一客户多个交叠旅程只能各自匹配，不能跨旅程拼接", () => {
  // 旅程 A: impression+click；旅程 B: click+conversion。时间上交叠。
  const events = [
    ev("c1", "A", "impression", 100, 1),
    ev("c1", "B", "click", 150, 1),
    ev("c1", "A", "click", 200, 1),
    ev("c1", "B", "conversion", 250, 1),
  ];
  const a = new FunnelAnalyzer(prepare(events));
  // 阶段1：A 有 impression -> 1；阶段2：A 有 imp->click -> 1
  // 阶段3：A 缺第二个 click，B 没有 impression -> 0；阶段4 -> 0
  assert.deepEqual(a.query(0, 1000), [1, 1, 0, 0]);
});

test("同一客户重复完成只计 1 人，不同客户分别计数", () => {
  const events = [
    ev("c1", "j1", "impression", 100, 1),
    ev("c1", "j1", "click", 200, 1),
    ev("c1", "j1", "click", 300, 1),
    ev("c1", "j1", "conversion", 400, 1),
    ev("c1", "j2", "impression", 150, 1),
    ev("c1", "j2", "click", 250, 1),
    ev("c1", "j2", "click", 350, 1),
    ev("c1", "j2", "conversion", 450, 1),
    ev("c2", "j3", "impression", 100, 1),
    ev("c2", "j3", "click", 200, 1),
  ];
  const a = new FunnelAnalyzer(prepare(events));
  assert.deepEqual(a.query(0, 1000), [2, 2, 1, 1]);
});

test("允许夹杂其他动作", () => {
  const events = [
    ev("c1", "j1", "impression", 100, 1),
    ev("c1", "j1", "scroll", 150, 1),
    ev("c1", "j1", "click", 200, 1),
    ev("c1", "j1", "hover", 250, 1),
    ev("c1", "j1", "click", 300, 1),
    ev("c1", "j1", "scroll", 350, 1),
    ev("c1", "j1", "conversion", 400, 1),
  ];
  const a = new FunnelAnalyzer(prepare(events));
  assert.deepEqual(a.query(0, 1000), [1, 1, 1, 1]);
});

test("乱序输入与完整计算一致（随机小数据）", () => {
  const rng = mulberry32(42);
  const actions = ["impression", "click", "conversion", "scroll", "hover"];
  for (let round = 0; round < 30; round++) {
    const events: FunnelEvent[] = [];
    const nCust = 1 + Math.floor(rng() * 5);
    const nJour = 1 + Math.floor(rng() * 8);
    const journeys: { id: string; cust: string }[] = [];
    for (let j = 0; j < nJour; j++) {
      journeys.push({ id: "j" + j, cust: "c" + Math.floor(rng() * nCust) });
    }
    const nEv = Math.floor(rng() * 60);
    for (let i = 0; i < nEv; i++) {
      const j = journeys[Math.floor(rng() * journeys.length)];
      events.push(ev(j.cust, j.id, actions[Math.floor(rng() * actions.length)], Math.floor(rng() * 200), Math.floor(rng() * 10)));
    }
    // 打乱输入顺序
    for (let i = events.length - 1; i > 0; i--) {
      const k = Math.floor(rng() * (i + 1));
      [events[i], events[k]] = [events[k], events[i]];
    }
    const a = new FunnelAnalyzer(prepare(events));
    const windows: [number, number][] = [];
    for (let w = 0; w < 200; w++) {
      const s = Math.floor(rng() * 220) - 10;
      const e = s + Math.floor(rng() * 220) - 10;
      windows.push([s, e]);
    }
    const got = queryAll(a, windows);
    const want = windows.map(([s, e]) => bruteForce(events, s, e));
    assert.deepEqual(got, want, `round ${round}`);
  }
});

test("保存后重开结果完全一致", () => {
  const rng = mulberry32(7);
  const actions = ["impression", "click", "conversion", "other"];
  const events: FunnelEvent[] = [];
  const journeyCust: string[] = [];
  for (let j = 0; j < 200; j++) journeyCust.push("c" + Math.floor(rng() * 50));
  for (let i = 0; i < 5000; i++) {
    const j = Math.floor(rng() * 200);
    events.push(
      ev(
        journeyCust[j],
        "j" + j,
        actions[Math.floor(rng() * actions.length)],
        Math.floor(rng() * 10000),
        Math.floor(rng() * 5),
      ),
    );
  }
  const prepared = prepare(events);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "funnel-"));
  const file = path.join(dir, "data.jf");
  save(prepared, file);
  const reopened = open(file);
  const direct = new FunnelAnalyzer(prepared);
  const windows: [number, number][] = [];
  for (let w = 0; w < 500; w++) {
    const s = Math.floor(rng() * 11000) - 500;
    const e = s + Math.floor(rng() * 11000) - 500;
    windows.push([s, e]);
    const [qs, qe] = windows[w];
    assert.deepEqual(reopened.query(qs, qe), direct.query(qs, qe));
    assert.deepEqual(reopened.query(qs, qe), bruteForce(events, qs, qe));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("空数据集与极端窗口", () => {
  const a = new FunnelAnalyzer(prepare([]));
  assert.deepEqual(a.query(0, 1000), [0, 0, 0, 0]);
  assert.deepEqual(a.query(-1e15, 1e15), [0, 0, 0, 0]);
  const events = [ev("c1", "j1", "impression", 100, 1)];
  const a2 = new FunnelAnalyzer(prepare(events));
  assert.deepEqual(a2.query(-1e15, 1e15), [1, 0, 0, 0]);
  assert.deepEqual(a2.query(101, 1e15), [0, 0, 0, 0]);
  assert.deepEqual(a2.query(-1e15, 100), [0, 0, 0, 0]);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
