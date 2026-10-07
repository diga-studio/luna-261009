import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PumpTwin } from '../src/index';
import type { TelemetryPoint } from '../src/types';
import { referencePredict, assertSameResult, assertClose } from './reference';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_700_000_000_000; // 固定纪元起点，避免依赖当前时间

test('健康度恒定但频繁变速：无有限寿命估计', () => {
  const twin = new PumpTwin(3000, 100);
  const points: TelemetryPoint[] = [];
  // 每 10 分钟变一次速，实际扬程始终精确等于预期扬程的 0.95 倍。
  for (let i = 0; i < 6 * 24 * 10; i++) {
    const rpm = 1500 + (i % 7) * 200;
    const expected = 100 * (rpm / 3000) ** 2;
    points.push({ timestampMs: T0 + i * 10 * 60_000, rpm, head: 0.95 * expected });
  }
  twin.writeBatch(points);
  const r = twin.predict(T0 + 10 * DAY);
  assert.equal(r.status, 'no-finite-estimate');
  if (r.status === 'no-finite-estimate') {
    assertClose(r.fittedValue, 0.95, 1e-9, 'fitted');
    assertClose(r.slope, 0, 1e-9, 'slope');
  }
});

test('已知线性退化：斜率、拟合值与余寿命可手算核对', () => {
  const twin = new PumpTwin(3000, 100);
  // 恒速运行，每小时写入一条，健康度从 1.0 每运行小时下降 0.001。
  const points: TelemetryPoint[] = [];
  for (let i = 0; i <= 100; i++) {
    points.push({ timestampMs: T0 + i * HOUR, rpm: 3000, head: 100 * (1 - 0.001 * i) });
  }
  twin.writeBatch(points);
  const at = T0 + 100 * HOUR;
  const r = twin.predict(at);
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') {
    assertClose(r.slope, -0.001, 1e-9, 'slope');
    assertClose(r.fittedValue, 0.9, 1e-9, 'fitted');
    assertClose(r.remainingLifeHours, 100, 1e-6, 'rul');
  }
});

test('数据不足：空、单点、仅停机记录', () => {
  const twin = new PumpTwin(3000, 100);
  assert.equal(twin.predict(T0).status, 'insufficient-data');
  twin.writeBatch([{ timestampMs: T0, rpm: 3000, head: 100 }]);
  assert.equal(twin.predict(T0 + HOUR).status, 'insufficient-data');
  twin.writeBatch([{ timestampMs: T0 + HOUR, rpm: 0, head: 0 }]);
  // 两个点但只有一个运行点。
  assert.equal(twin.predict(T0 + 2 * HOUR).status, 'insufficient-data');
});

test('拟合值不高于 0.8 时余寿命为 0', () => {
  const twin = new PumpTwin(3000, 100);
  const points: TelemetryPoint[] = [];
  for (let i = 0; i <= 50; i++) {
    points.push({ timestampMs: T0 + i * HOUR, rpm: 3000, head: 100 * (1 - 0.005 * i) });
  }
  twin.writeBatch(points);
  const r = twin.predict(T0 + 50 * HOUR);
  assert.equal(r.status, 'exhausted');
  if (r.status === 'exhausted') {
    assert.equal(r.remainingLifeHours, 0);
    assert.ok(r.fittedValue <= 0.8);
  }
});

test('批次内同时间戳后者覆盖前者', () => {
  const twin = new PumpTwin(3000, 100);
  twin.writeBatch([
    { timestampMs: T0, rpm: 3000, head: 100 },
    { timestampMs: T0 + HOUR, rpm: 3000, head: 90 },
    { timestampMs: T0 + HOUR, rpm: 3000, head: 80 }, // 更正上一条
  ]);
  const r = twin.predict(T0 + HOUR);
  const ref = referencePredict(
    3000,
    100,
    [
      [
        { timestampMs: T0, rpm: 3000, head: 100 },
        { timestampMs: T0 + HOUR, rpm: 3000, head: 90 },
        { timestampMs: T0 + HOUR, rpm: 3000, head: 80 },
      ],
    ],
    T0 + HOUR,
  );
  assertSameResult(r, ref, 'overwrite');
  // 两点 (0h, 1.0) 与 (1h, 0.8)，T 处拟合值恰为 0.8，余寿命为 0。
  assert.equal(r.status, 'exhausted');
  if (r.status === 'exhausted') assertClose(r.fittedValue, 0.8, 1e-9, 'fitted');
});

test('停机、乱序补点、历史停机更正为运行：与逐点重算一致', () => {
  const twin = new PumpTwin(3000, 100);
  const writes: TelemetryPoint[][] = [];
  const push = (batch: TelemetryPoint[]) => {
    twin.writeBatch(batch);
    writes.push(batch);
  };
  // 基础序列：运行 10 小时后停机 5 小时，再运行，健康度随运行小时线性下降。
  const base: TelemetryPoint[] = [];
  let runHours = 0;
  for (let i = 0; i <= 30; i++) {
    const ts = T0 + i * HOUR;
    const stopped = i >= 10 && i < 15;
    const rpm = stopped ? 0 : 3000;
    if (!stopped && i > 0) runHours += 1;
    base.push({ timestampMs: ts, rpm, head: 100 * (1 - 0.002 * runHours) });
  }
  push(base);
  // 乱序补点：向历史中间插入新时间戳。
  const late: TelemetryPoint[] = [];
  for (let i = 0; i < 30; i += 2) {
    const ts = T0 + i * HOUR + 30 * 60_000;
    const stopped = i >= 10 && i < 14;
    late.push({
      timestampMs: ts,
      rpm: stopped ? 0 : 3000,
      head: 100 * (1 - 0.002 * (i >= 15 ? i - 4.5 : i + 0.5)),
    });
  }
  late.reverse(); // 故意倒序到达
  push(late);
  // 历史更正：把第 12 小时（原停机）更正为运行。
  push([{ timestampMs: T0 + 12 * HOUR, rpm: 3000, head: 100 * (1 - 0.002 * 3) }]);

  // 多个查询时刻：窗口内、边界上、最后记录之后、历史中间。
  const queryTimes = [
    T0 + 5 * HOUR,
    T0 + 12 * HOUR,
    T0 + 15 * HOUR,
    T0 + 30 * HOUR,
    T0 + 30 * HOUR + 1, // 最后记录之后继续保持最后转速
    T0 + 30 * DAY, // 窗口左端恰在首条记录
    T0 + 30 * DAY + 7 * HOUR,
  ];
  for (const at of queryTimes) {
    assertSameResult(twin.predict(at), referencePredict(3000, 100, writes, at), `at=${at - T0}ms`);
  }
});

test('窗口外与晚于查询时刻的记录不影响结果', () => {
  const twin = new PumpTwin(3000, 100);
  const writes: TelemetryPoint[][] = [];
  const batch: TelemetryPoint[] = [];
  for (let i = 0; i <= 20; i++) {
    batch.push({ timestampMs: T0 + i * HOUR, rpm: 3000, head: 100 * (1 - 0.001 * i) });
  }
  twin.writeBatch(batch);
  writes.push(batch);
  const at = T0 + 10 * HOUR;
  const before = twin.predict(at);
  // 写入晚于查询时刻的记录与 30 天窗口之外的记录。
  const extra: TelemetryPoint[] = [
    { timestampMs: at + HOUR, rpm: 3000, head: 1 },
    { timestampMs: at + 40 * DAY, rpm: 3000, head: 1 },
    { timestampMs: at - 40 * DAY, rpm: 3000, head: 1 },
  ];
  twin.writeBatch(extra);
  writes.push(extra);
  const after = twin.predict(at);
  assertSameResult(after, before, 'stability');
  assertSameResult(after, referencePredict(3000, 100, writes, at), 'window');
});
