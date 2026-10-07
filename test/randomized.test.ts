import assert from 'node:assert/strict';
import test from 'node:test';
import { PumpTwin } from '../src/index';
import { LifeAssessment, TelemetryPoint } from '../src/types';
import { mulberry32, naiveAssess } from './reference';

const H = 3_600_000;
const DAY = 24 * H;

function relClose(actual: number, expected: number, rel: number, abs: number): boolean {
  return Math.abs(actual - expected) <= Math.max(abs, rel * Math.abs(expected));
}

function assertAssessmentsEqual(
  actual: LifeAssessment,
  expected: LifeAssessment,
  ctx: string,
): void {
  if (actual.status !== expected.status) {
    // Tolerate status flips only exactly on a decision boundary.
    const aFit = 'fittedNormalizedHead' in actual ? actual.fittedNormalizedHead : NaN;
    const eFit = 'fittedNormalizedHead' in expected ? expected.fittedNormalizedHead : NaN;
    assert.ok(
      Number.isFinite(aFit) &&
        Number.isFinite(eFit) &&
        (Math.abs(aFit - 0.8) < 1e-9 || Math.abs(eFit - 0.8) < 1e-9),
      `${ctx}: status ${actual.status} != ${expected.status} (fits ${aFit} vs ${eFit})`,
    );
    return;
  }
  if ('slope' in actual && 'slope' in expected) {
    assert.ok(
      relClose(actual.slope, expected.slope, 1e-9, 1e-12),
      `${ctx}: slope ${actual.slope} vs ${expected.slope}`,
    );
    assert.ok(
      relClose(
        actual.fittedNormalizedHead,
        expected.fittedNormalizedHead,
        1e-9,
        1e-12,
      ),
      `${ctx}: fit ${actual.fittedNormalizedHead} vs ${expected.fittedNormalizedHead}`,
    );
  }
  if (actual.status === 'finite' && expected.status === 'finite') {
    const rel = Math.abs(
      (actual.remainingOperatingHours - expected.remainingOperatingHours) /
        expected.remainingOperatingHours,
    );
    assert.ok(
      rel <= 1e-6 || relClose(actual.remainingOperatingHours, expected.remainingOperatingHours, 1e-9, 1e-9),
      `${ctx}: RUL ${actual.remainingOperatingHours} vs ${expected.remainingOperatingHours}`,
    );
  }
}

interface Scenario {
  twin: PumpTwin;
  records: Map<number, TelemetryPoint>;
  ratedSpeed: number;
  ratedHead: number;
  horizonMs: number;
}

function buildScenario(seed: number, count: number): Scenario {
  const ratedSpeed = 3000;
  const ratedHead = 100;
  const rnd = mulberry32(seed);
  const records = new Map<number, TelemetryPoint>();
  // Irregular timestamps over ~40 days, mix of running and stopped.
  let t = 0;
  const base: TelemetryPoint[] = [];
  for (let i = 0; i < count; i++) {
    t += Math.floor(rnd() * 6 * H) + 1;
    const stopped = rnd() < 0.25;
    const speed = stopped ? 0 : 1000 + Math.floor(rnd() * 2500);
    const ratio = speed / ratedSpeed;
    // Slow degradation plus noise, clearly away from the 0.8 boundary.
    const health = 0.95 - 0.0001 * (t / H) * (0.5 + rnd());
    const head = health * ratedHead * ratio * ratio * (1 + (rnd() - 0.5) * 0.001);
    base.push({ timestampMs: t, speed, head });
  }
  // Shuffle to simulate out-of-order arrival, then load in batches.
  const shuffled = [...base];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const twin = new PumpTwin(ratedSpeed, ratedHead);
  const batchSize = 97;
  for (let i = 0; i < shuffled.length; i += batchSize) {
    const batch = shuffled.slice(i, i + batchSize);
    twin.writeTelemetry(batch);
    for (const p of batch) records.set(p.timestampMs, p);
  }
  return { twin, records, ratedSpeed, ratedHead, horizonMs: t };
}

function compareAtRandomTimes(s: Scenario, seed: number, queries: number): void {
  const rnd = mulberry32(seed);
  for (let q = 0; q < queries; q++) {
    const T = Math.floor(rnd() * (s.horizonMs + 10 * DAY));
    const actual = s.twin.assessRemainingLife(T);
    const expected = naiveAssess(s.records, s.ratedSpeed, s.ratedHead, T);
    assertAssessmentsEqual(actual, expected, `T=${T}`);
  }
}

test('stops and out-of-order backfill match naive recomputation', () => {
  const s = buildScenario(42, 1500);
  compareAtRandomTimes(s, 7, 60);
});

test('late backfill of brand-new historical points matches naive', () => {
  const s = buildScenario(43, 800);
  const rnd = mulberry32(99);
  // Insert new (previously missing) timestamps into retained history.
  for (let k = 0; k < 30; k++) {
    const t = Math.floor(rnd() * s.horizonMs);
    if (s.records.has(t)) continue;
    const speed = rnd() < 0.3 ? 0 : 1000 + Math.floor(rnd() * 2500);
    const ratio = speed / s.ratedSpeed;
    const p = { timestampMs: t, speed, head: 0.9 * s.ratedHead * ratio * ratio };
    s.twin.writeTelemetry([p]);
    s.records.set(t, p);
  }
  compareAtRandomTimes(s, 8, 60);
});

test('correcting historical stops to running matches naive', () => {
  const s = buildScenario(44, 1200);
  const rnd = mulberry32(123);
  const stops = [...s.records.values()].filter((p) => p.speed === 0);
  assert.ok(stops.length > 0, 'scenario should contain stops');
  for (let k = 0; k < 40; k++) {
    const victim = stops[Math.floor(rnd() * stops.length)];
    const speed = 1000 + Math.floor(rnd() * 2500);
    const ratio = speed / s.ratedSpeed;
    const corrected = {
      timestampMs: victim.timestampMs,
      speed,
      head: 0.88 * s.ratedHead * ratio * ratio,
    };
    s.twin.writeTelemetry([corrected]);
    s.records.set(corrected.timestampMs, corrected);
    // Every correction must be visible immediately.
    const T = Math.floor(rnd() * (s.horizonMs + 5 * DAY));
    assertAssessmentsEqual(
      s.twin.assessRemainingLife(T),
      naiveAssess(s.records, s.ratedSpeed, s.ratedHead, T),
      `after correction ${k} at ts=${corrected.timestampMs}, T=${T}`,
    );
  }
  compareAtRandomTimes(s, 9, 40);
});

test('correcting running records to stops matches naive', () => {
  const s = buildScenario(45, 1200);
  const rnd = mulberry32(321);
  const running = [...s.records.values()].filter((p) => p.speed > 0);
  for (let k = 0; k < 40; k++) {
    const victim = running[Math.floor(rnd() * running.length)];
    const corrected = { timestampMs: victim.timestampMs, speed: 0, head: 0 };
    s.twin.writeTelemetry([corrected]);
    s.records.set(corrected.timestampMs, corrected);
  }
  compareAtRandomTimes(s, 10, 60);
});
