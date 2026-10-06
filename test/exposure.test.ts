import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExposureStats } from '../src/index.js';
import type { ActivityConfig, DirectorEvent, InitialState } from '../src/index.js';

const FULL = { x: 0, y: 0, width: 10000, height: 10000 };

test('同一输入多个重叠槽位 + 多重半透明叠层', () => {
  // 槽位（从下到上）：A 全屏(z1) < B 右下四分之一(z2) < A 中央(z3)
  // B 实际可见 = [5000,10000]^2 去掉与 A 中央槽位的交集 [5000,7500]^2
  //   => 25e6 - 6.25e6 = 18.75e6，全部在 O2 之外，衰减 0.5 => 9.375e6
  // A 可见 = 画布其余部分 81.25e6；其中 O2 区域 [0,5000]^2 衰减 0.25，
  //   其余衰减 0.5 => 25e6*0.25 + 56.25e6*0.5 = 34.375e6
  const config: ActivityConfig = {
    scenes: [
      {
        id: 'S1',
        slots: [
          { inputId: 'A', rect: FULL, zIndex: 1, visible: true },
          { inputId: 'B', rect: { x: 5000, y: 5000, width: 5000, height: 5000 }, zIndex: 2, visible: true },
          { inputId: 'A', rect: { x: 2500, y: 2500, width: 5000, height: 5000 }, zIndex: 3, visible: true },
        ],
      },
    ],
    overlays: [
      { id: 'O1', rect: FULL, opacity: 0.5, visible: true },
      { id: 'O2', rect: { x: 0, y: 0, width: 5000, height: 5000 }, opacity: 0.5, visible: true },
    ],
  };
  const initial: InitialState = { sceneId: 'S1', inputStates: { A: 'active', B: 'active' } };
  const stats = new ExposureStats(config, 1000, initial, []);

  const r = stats.query(0, 1000);
  assert.equal(r.get('A'), 343.75);
  assert.equal(r.get('B'), 93.75);

  // 只查一半时长，结果减半（状态不变）
  const half = stats.query(0, 500);
  assert.equal(half.get('A'), 171.875);
  assert.equal(half.get('B'), 46.875);
});

test('同时间戳连续切换，端点落在切换时刻，无虚假曝光', () => {
  const config: ActivityConfig = {
    scenes: [
      { id: 'S1', slots: [{ inputId: 'A', rect: FULL, zIndex: 1, visible: true }] },
      { id: 'S2', slots: [{ inputId: 'B', rect: FULL, zIndex: 1, visible: true }] },
    ],
    overlays: [],
  };
  const initial: InitialState = { sceneId: 'S1', inputStates: { A: 'active', B: 'active' } };
  const events: DirectorEvent[] = [
    { timeMs: 500, type: 'switchScene', sceneId: 'S2' },
    { timeMs: 500, type: 'setInputState', inputId: 'A', state: 'standby' },
  ];
  const stats = new ExposureStats(config, 1000, initial, events);

  // 左闭右开：[0,500) 全部属于 S1 的 A
  const before = stats.query(0, 500);
  assert.equal(before.get('A'), 500);
  assert.equal(before.get('B'), undefined);

  // [500,1000) 全部属于 S2 的 B；A 已 standby 且无槽位
  const after = stats.query(500, 1000);
  assert.equal(after.get('B'), 500);
  assert.equal(after.get('A'), undefined);

  // 相邻区间之和与合并区间严格一致
  const merged = stats.query(0, 1000);
  assert.equal(merged.get('A'), (before.get('A') ?? 0) + (after.get('A') ?? 0));
  assert.equal(merged.get('B'), (before.get('B') ?? 0) + (after.get('B') ?? 0));

  // 跨过切换点的 2ms 窗口：A、B 各 1ms，没有第三种状态插入
  const across = stats.query(499, 501);
  assert.equal(across.get('A'), 1);
  assert.equal(across.get('B'), 1);

  // 空区间
  assert.equal(stats.query(500, 500).size, 0);
});

test('standby/disabled 与隐藏槽位不参与画面也不遮挡', () => {
  const config: ActivityConfig = {
    scenes: [
      {
        id: 'S1',
        slots: [
          { inputId: 'A', rect: FULL, zIndex: 1, visible: true },
          { inputId: 'B', rect: FULL, zIndex: 2, visible: true }, // standby，不遮挡
          { inputId: 'C', rect: FULL, zIndex: 3, visible: false }, // 隐藏
          { inputId: 'D', rect: FULL, zIndex: 4, visible: true }, // disabled，不遮挡
        ],
      },
    ],
    overlays: [],
  };
  const initial: InitialState = {
    sceneId: 'S1',
    inputStates: { A: 'active', B: 'standby', C: 'active', D: 'disabled' },
  };
  const stats = new ExposureStats(config, 1000, initial, []);
  const r = stats.query(0, 1000);
  assert.equal(r.get('A'), 1000);
  assert.equal(r.size, 1);
});

test('超出画布的矩形被裁掉，隐藏叠层不遮挡，叠层显隐可切换', () => {
  const config: ActivityConfig = {
    scenes: [
      {
        id: 'S1',
        slots: [
          // 只有右下角四分之一在画布内
          { inputId: 'A', rect: { x: 5000, y: 5000, width: 10000, height: 10000 }, zIndex: 1, visible: true },
        ],
      },
    ],
    overlays: [
      { id: 'O1', rect: FULL, opacity: 0.5, visible: false }, // 隐藏，不遮挡
      { id: 'O2', rect: FULL, opacity: 0.5, visible: true },
    ],
  };
  const initial: InitialState = { sceneId: 'S1', inputStates: { A: 'active' } };
  const events: DirectorEvent[] = [
    { timeMs: 400, type: 'setOverlayVisible', overlayId: 'O2', visible: false },
    { timeMs: 800, type: 'setOverlayVisible', overlayId: 'O1', visible: true },
  ];
  const stats = new ExposureStats(config, 1200, initial, events);

  // [0,400)：O2 可见，1/4 面积 * 0.5 => 每毫秒 0.125 => 50
  assert.equal(stats.query(0, 400).get('A'), 50);
  // [400,800)：无可见叠层，1/4 面积 => 100
  assert.equal(stats.query(400, 800).get('A'), 100);
  // [800,1200)：O1 可见，同第一段 => 50
  assert.equal(stats.query(800, 1200).get('A'), 50);
  // 合并区间
  assert.equal(stats.query(0, 1200).get('A'), 200);
});

test('查询顺序不影响结果', () => {
  const config: ActivityConfig = {
    scenes: [
      { id: 'S1', slots: [{ inputId: 'A', rect: FULL, zIndex: 1, visible: true }] },
      { id: 'S2', slots: [{ inputId: 'B', rect: FULL, zIndex: 1, visible: true }] },
    ],
    overlays: [],
  };
  const initial: InitialState = { sceneId: 'S1', inputStates: { A: 'active', B: 'active' } };
  const events: DirectorEvent[] = [{ timeMs: 300, type: 'switchScene', sceneId: 'S2' }];

  const s1 = new ExposureStats(config, 1000, initial, events);
  const s2 = new ExposureStats(config, 1000, initial, events);

  // s1 先查后半再查前半；s2 顺序相反
  const s1After = s1.query(300, 1000);
  const s1Before = s1.query(0, 300);
  const s2Before = s2.query(0, 300);
  const s2After = s2.query(300, 1000);

  assert.deepEqual([...s1Before.entries()], [...s2Before.entries()]);
  assert.deepEqual([...s1After.entries()], [...s2After.entries()]);
});
