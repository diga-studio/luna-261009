import { test } from "node:test";
import assert from "node:assert/strict";
import { ExposureTracker, type ActivityConfig, type Operation } from "../src/index.js";

const EPS = 1e-6;

function assertClose(actual: number, expected: number, msg: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${msg}: 期望 ${expected}，实际 ${actual}`,
  );
}

/** 构造基础配置，便于各测试覆盖修改 */
function baseConfig(overrides: Partial<ActivityConfig>): ActivityConfig {
  return {
    durationMs: 10000,
    initialSceneId: "s1",
    scenes: [],
    inputs: [],
    overlays: [],
    ...overrides,
  };
}

test("同一输入多个重叠槽位 + 多重半透明叠层，结果与手算面积一致", () => {
  // 槽位1: (0,0,6000,6000)，槽位2: (3000,3000,6000,6000)，同属输入 A，z 相同
  // 并集面积 = 36e6 + 36e6 - 9e6 = 63e6（万分比平方）
  // 叠层 O1: 全画布 opacity 0.5 → 全局系数 0.5
  // 叠层 O2: x∈[3000,7000) opacity 0.2 → 该区域再乘 0.8
  // 加权面积（未乘 O1）：
  //   槽位1: x[0,3000)y[0,6000) 18e6@1 + x[3000,6000)y[0,6000) 18e6@0.8
  //   槽位2减槽位1: x[6000,7000)y[3000,9000) 6e6@0.8
  //              + x[7000,9000)y[3000,9000) 12e6@1
  //              + x[3000,6000)y[6000,9000) 9e6@0.8
  //   合计 = 18 + 14.4 + 4.8 + 12 + 7.2 = 56.4e6
  // 乘 O1 系数 0.5 → 28.2e6 → 占比 0.282
  // 全程 10000ms → 有效出镜 2820ms
  const config = baseConfig({
    scenes: [
      {
        id: "s1",
        slots: [
          { inputId: "A", rect: { x: 0, y: 0, w: 6000, h: 6000 }, z: 0, visible: true },
          { inputId: "A", rect: { x: 3000, y: 3000, w: 6000, h: 6000 }, z: 0, visible: true },
          // standby 输入的槽位不参与画面，也不遮挡
          { inputId: "B", rect: { x: 0, y: 0, w: 10000, h: 10000 }, z: 99, visible: true },
        ],
      },
    ],
    inputs: [
      { id: "A", state: "active" },
      { id: "B", state: "standby" },
    ],
    overlays: [
      { id: "o1", rect: { x: 0, y: 0, w: 10000, h: 10000 }, opacity: 0.5, visible: true },
      { id: "o2", rect: { x: 3000, y: 0, w: 4000, h: 10000 }, opacity: 0.2, visible: true },
    ],
  });
  const tracker = new ExposureTracker(config, []);

  const full = tracker.query(0, 10000);
  assertClose(full.get("A") ?? 0, 2820, "A 全程有效出镜");
  assert.equal(full.get("B") ?? 0, 0, "standby 输入无出镜");

  // 子区间 [2000, 5000)：0.282 * 3000 = 846
  const sub = tracker.query(2000, 5000);
  assertClose(sub.get("A") ?? 0, 846, "A 子区间有效出镜");

  // 相邻区间相加等于合并区间
  const left = tracker.query(0, 4000).get("A") ?? 0;
  const right = tracker.query(4000, 10000).get("A") ?? 0;
  assertClose(left + right, 2820, "相邻区间之和等于合并区间");
});

test("同时间戳连续切换，查询端点落在切换时刻，无虚假曝光", () => {
  const scenes = [
    {
      id: "s1",
      slots: [
        { inputId: "A", rect: { x: 0, y: 0, w: 10000, h: 10000 }, z: 0, visible: true },
      ],
    },
    {
      id: "s2",
      slots: [
        { inputId: "B", rect: { x: 0, y: 0, w: 10000, h: 10000 }, z: 0, visible: true },
      ],
    },
  ];
  const inputs = [
    { id: "A", state: "active" as const },
    { id: "B", state: "active" as const },
  ];

  // 同一时刻先切到 s2 又切回 s1：s2 不应产生任何曝光
  const ops1: Operation[] = [
    { timeMs: 5000, type: "switchScene", sceneId: "s2" },
    { timeMs: 5000, type: "switchScene", sceneId: "s1" },
  ];
  const t1 = new ExposureTracker(
    baseConfig({ scenes, inputs }),
    ops1,
  );
  const r1 = t1.query(0, 10000);
  assertClose(r1.get("A") ?? 0, 10000, "A 应覆盖全程");
  assert.equal(r1.get("B") ?? 0, 0, "B 不应有虚假曝光");
  // 端点恰好落在切换时刻
  assertClose(t1.query(0, 5000).get("A") ?? 0, 5000, "前半段全是 A");
  assertClose(t1.query(5000, 10000).get("A") ?? 0, 5000, "后半段仍是 A");
  assertClose(t1.query(4999, 5001).get("A") ?? 0, 2, "跨越切换点的微区间");

  // 单次切换：端点落在切换时刻，前后归属清晰
  const ops2: Operation[] = [
    { timeMs: 5000, type: "switchScene", sceneId: "s2" },
  ];
  const t2 = new ExposureTracker(
    baseConfig({ scenes, inputs }),
    ops2,
  );
  assertClose(t2.query(0, 5000).get("A") ?? 0, 5000, "切换前全是 A");
  assert.equal(t2.query(0, 5000).get("B") ?? 0, 0, "切换前无 B");
  assertClose(t2.query(5000, 10000).get("B") ?? 0, 5000, "切换后全是 B");
  assert.equal(t2.query(5000, 10000).get("A") ?? 0, 0, "切换后无 A");
  assert.equal(t2.query(5000, 5000).size, 0, "空区间无结果");

  // 同时间戳混合操作：切场景 + 改输入状态 + 改叠层显隐，按记录顺序全部生效
  const config3 = baseConfig({
    scenes,
    inputs,
    overlays: [
      { id: "o1", rect: { x: 0, y: 0, w: 10000, h: 10000 }, opacity: 1, visible: false },
    ],
  });
  const ops3: Operation[] = [
    { timeMs: 5000, type: "switchScene", sceneId: "s2" },
    { timeMs: 5000, type: "setInputState", inputId: "B", state: "standby" },
    { timeMs: 5000, type: "setOverlayVisible", overlayId: "o1", visible: true },
  ];
  const t3 = new ExposureTracker(config3, ops3);
  const r3 = t3.query(5000, 10000);
  assert.equal(r3.get("B") ?? 0, 0, "B standby 后无出镜");
  assert.equal(r3.size, 0, "后半段无任何出镜");
});

test("z 值相同按配置顺序决定上下，隐藏槽位与 disabled 输入不遮挡", () => {
  const config = baseConfig({
    scenes: [
      {
        id: "s1",
        slots: [
          { inputId: "A", rect: { x: 0, y: 0, w: 5000, h: 5000 }, z: 0, visible: true },
          // 与 A 同 z，配置靠后，压住 A 的右上四分之一
          { inputId: "B", rect: { x: 2500, y: 2500, w: 2500, h: 2500 }, z: 0, visible: true },
          // 隐藏槽位不遮挡
          { inputId: "C", rect: { x: 0, y: 0, w: 10000, h: 10000 }, z: 50, visible: false },
          // disabled 输入的槽位不遮挡
          { inputId: "D", rect: { x: 0, y: 0, w: 10000, h: 10000 }, z: 60, visible: true },
        ],
      },
    ],
    inputs: [
      { id: "A", state: "active" },
      { id: "B", state: "active" },
      { id: "C", state: "active" },
      { id: "D", state: "disabled" },
    ],
  });
  const r = new ExposureTracker(config, []).query(0, 10000);
  // A: 25e6 - 6.25e6 = 18.75e6 → 0.1875 → 1875ms
  assertClose(r.get("A") ?? 0, 1875, "A 被 B 压住一部分");
  // B: 6.25e6 → 0.0625 → 625ms
  assertClose(r.get("B") ?? 0, 625, "B 占据自己的槽位");
  assert.equal(r.get("C") ?? 0, 0, "隐藏槽位无出镜");
  assert.equal(r.get("D") ?? 0, 0, "disabled 无出镜");
});

test("矩形超出画布部分被裁掉，按画布内实际面积计算", () => {
  const config = baseConfig({
    scenes: [
      {
        id: "s1",
        slots: [
          // 覆盖 x∈[-5000,5000) y∈[-5000,5000)，画布内只剩四分之一
          { inputId: "A", rect: { x: -5000, y: -5000, w: 10000, h: 10000 }, z: 0, visible: true },
        ],
      },
    ],
    inputs: [{ id: "A", state: "active" }],
  });
  const r = new ExposureTracker(config, []).query(0, 10000);
  assertClose(r.get("A") ?? 0, 2500, "画布内面积占比 0.25");
});

test("输入状态与叠层显隐在活动进行中变化", () => {
  const config = baseConfig({
    scenes: [
      {
        id: "s1",
        slots: [
          { inputId: "A", rect: { x: 0, y: 0, w: 10000, h: 10000 }, z: 0, visible: true },
        ],
      },
    ],
    inputs: [{ id: "A", state: "active" }],
    overlays: [
      { id: "o1", rect: { x: 0, y: 0, w: 10000, h: 10000 }, opacity: 0.5, visible: false },
    ],
  });
  const ops: Operation[] = [
    { timeMs: 2000, type: "setOverlayVisible", overlayId: "o1", visible: true },
    { timeMs: 6000, type: "setInputState", inputId: "A", state: "disabled" },
  ];
  const t = new ExposureTracker(config, ops);
  // [0,2000): 系数 1 → 2000ms；[2000,6000): 系数 0.5 → 2000ms；[6000,10000): 0
  const r = t.query(0, 10000);
  assertClose(r.get("A") ?? 0, 4000, "分段合计");
  assertClose(t.query(0, 2000).get("A") ?? 0, 2000, "叠层出现前");
  assertClose(t.query(2000, 6000).get("A") ?? 0, 2000, "叠层半透明期间");
  assert.equal(t.query(6000, 10000).get("A") ?? 0, 0, "disabled 后无出镜");
});

test("查询顺序不影响结果", () => {
  const config = baseConfig({
    scenes: [
      {
        id: "s1",
        slots: [
          { inputId: "A", rect: { x: 0, y: 0, w: 5000, h: 10000 }, z: 0, visible: true },
        ],
      },
    ],
    inputs: [{ id: "A", state: "active" }],
  });
  const t = new ExposureTracker(config, []);
  const first = t.query(3000, 7000).get("A") ?? 0;
  t.query(0, 10000);
  t.query(0, 3000);
  const second = t.query(3000, 7000).get("A") ?? 0;
  assertClose(first, second, "重复查询结果一致");
  assertClose(first, 2000, "占比 0.5 × 4000ms");
});
