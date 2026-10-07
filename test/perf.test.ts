import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PumpTwin } from '../src/index';
import type { TelemetryPoint } from '../src/types';
import { ReferenceTwin, assertSameResult } from './reference';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

/** 确定性伪随机数（LCG），保证测试可复现。 */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('密集30天窗口：100万条记录 + 2000次更正与2000次查询', { timeout: 120_000 }, () => {
  const N = 1_000_000;
  const STEP_MS = 2_500; // 250万秒 ≈ 28.9 天，全部落在同一30天窗口
  const ratedRpm = 3000;
  const ratedHead = 100;

  const rand = makeRandom(42);
  const twin = new PumpTwin(ratedRpm, ratedHead);
  const ref = new ReferenceTwin(ratedRpm, ratedHead);

  // 初始加载：每 97 条有一条停机记录，健康度随运行小时线性下降。
  const load: TelemetryPoint[] = new Array(N);
  let runHours = 0;
  for (let i = 0; i < N; i++) {
    const stopped = i % 97 === 0;
    const rpm = stopped ? 0 : 2400 + (i % 5) * 150;
    if (i > 0 && !stopped) runHours += STEP_MS / HOUR;
    const expected = ratedHead * (rpm / ratedRpm) ** 2;
    load[i] = {
      timestampMs: T0 + i * STEP_MS,
      rpm,
      head: stopped ? 0 : expected * (1 - 0.0002 * runHours),
    };
  }
  twin.writeBatch(load);
  ref.writeBatch(load);

  // 交替执行 2000 次历史单点更正与 2000 次查询，只统计这段耗时。
  const ROUNDS = 2000;
  const corrections: TelemetryPoint[] = new Array(ROUNDS);
  const queryTimes: number[] = new Array(ROUNDS);
  for (let k = 0; k < ROUNDS; k++) {
    const idx = 1 + Math.floor(rand() * (N - 1));
    const ts = T0 + idx * STEP_MS;
    // 更正可翻转历史运行/停机状态。
    const toStopped = rand() < 0.3;
    const rpm = toStopped ? 0 : 2400 + Math.floor(rand() * 5) * 150;
    const expected = ratedHead * (rpm / ratedRpm) ** 2;
    corrections[k] = {
      timestampMs: ts,
      rpm,
      head: toStopped ? 0 : expected * (0.8 + rand() * 0.2),
    };
    queryTimes[k] = T0 + Math.floor(rand() * (N * STEP_MS));
  }

  const start = process.hrtime.bigint();
  for (let k = 0; k < ROUNDS; k++) {
    twin.writeBatch([corrections[k]!]);
    twin.predict(queryTimes[k]!);
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(
    `2000 corrections + 2000 queries over ${N} records: ${elapsedMs.toFixed(0)} ms`,
  );
  assert.ok(elapsedMs < 10_000, `too slow: ${elapsedMs} ms`);

  // 把同样的更正应用到参考实现，抽样查询逐点重算对照。
  for (let k = 0; k < ROUNDS; k++) {
    ref.writeBatch([corrections[k]!]);
  }
  const verifyRand = makeRandom(7);
  for (let v = 0; v < 10; v++) {
    const at = T0 + Math.floor(verifyRand() * (N * STEP_MS));
    assertSameResult(twin.predict(at), ref.predict(at), `verify at=${at - T0}ms`);
  }
});
