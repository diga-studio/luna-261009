import assert from 'node:assert/strict';
import { hrtime } from 'node:process';
import test from 'node:test';
import { PumpTwin } from '../src/index';
import { LifeAssessment, TelemetryPoint } from '../src/types';
import { mulberry32, naiveAssessSorted } from './reference';

const H = 3_600_000;
const RECORDS = 1_000_000;
const ROUNDS = 2_000;
const BUDGET_MS = 10_000;

function buildDenseRecords(seed: number): TelemetryPoint[] {
  const rnd = mulberry32(seed);
  const ratedSpeed = 3000;
  const ratedHead = 100;
  const spacing = Math.floor((30 * 24 * H) / RECORDS); // ~2.6s, all in 30 days
  const points = new Array<TelemetryPoint>(RECORDS);
  for (let i = 0; i < RECORDS; i++) {
    const stopped = rnd() < 0.08;
    const speed = stopped ? 0 : 1200 + Math.floor(rnd() * 2200);
    const ratio = speed / ratedSpeed;
    const health = 0.98 - 0.00008 * (i * spacing) / H + (rnd() - 0.5) * 0.002;
    points[i] = {
      timestampMs: i * spacing,
      speed,
      head: health * ratedHead * ratio * ratio,
    };
  }
  return points;
}

test('1M dense records: 2000 corrections + 2000 queries within budget', () => {
  const ratedSpeed = 3000;
  const ratedHead = 100;
  const twin = new PumpTwin(ratedSpeed, ratedHead);
  const records = new Map<number, TelemetryPoint>();

  const initial = buildDenseRecords(1);
  // Shuffle the initial load to exercise out-of-order bulk ingest.
  const rnd = mulberry32(2);
  for (let i = initial.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [initial[i], initial[j]] = [initial[j], initial[i]];
  }
  twin.writeTelemetry(initial);
  for (const p of initial) records.set(p.timestampMs, p);
  const maxT = initial.reduce((m, p) => Math.max(m, p.timestampMs), 0);

  const timestamps = [...records.keys()].sort((a, b) => a - b);
  const spotChecks: number[] = [];
  let elapsedMs = 0;
  const statuses = new Map<string, number>();

  for (let k = 0; k < ROUNDS; k++) {
    // Historical single-point correction: may flip run/stop state.
    const victim = timestamps[Math.floor(rnd() * timestamps.length)];
    const stopped = rnd() < 0.15;
    const speed = stopped ? 0 : 1200 + Math.floor(rnd() * 2200);
    const ratio = speed / ratedSpeed;
    const corrected: TelemetryPoint = {
      timestampMs: victim,
      speed,
      head: (0.9 + rnd() * 0.05) * ratedHead * ratio * ratio,
    };
    const T = timestamps[Math.floor(rnd() * timestamps.length)];

    const t0 = hrtime.bigint();
    twin.writeTelemetry([corrected]);
    const result = twin.assessRemainingLife(T);
    const t1 = hrtime.bigint();
    elapsedMs += Number(t1 - t0) / 1e6;

    records.set(victim, corrected);
    statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
    if (k % 400 === 0) spotChecks.push(T);
  }

  assert.ok(
    elapsedMs <= BUDGET_MS,
    `compute time ${elapsedMs.toFixed(0)}ms exceeds ${BUDGET_MS}ms`,
  );
  console.log(
    `compute time for ${ROUNDS} corrections + ${ROUNDS} queries: ${elapsedMs.toFixed(1)}ms`,
    `statuses: ${[...statuses.entries()].map(([s, n]) => `${s}=${n}`).join(', ')}`,
  );

  // Numeric spot checks against independent point-by-point recomputation.
  const sortedFinal = [...records.values()].sort(
    (x, y) => x.timestampMs - y.timestampMs,
  );
  for (const T of spotChecks) {
    const actual = twin.assessRemainingLife(T);
    const expected = naiveAssessSorted(sortedFinal, ratedSpeed, ratedHead, T);
    assert.equal(actual.status, expected.status, `status at T=${T}`);
    if (actual.status === 'finite' && expected.status === 'finite') {
      const rel = Math.abs(
        (actual.remainingOperatingHours - expected.remainingOperatingHours) /
          expected.remainingOperatingHours,
      );
      assert.ok(
        rel <= 1e-6,
        `RUL relative error ${rel} at T=${T} (${actual.remainingOperatingHours} vs ${expected.remainingOperatingHours})`,
      );
      assert.ok(
        Math.abs(actual.slope - expected.slope) <=
          1e-9 * Math.max(1, Math.abs(expected.slope)),
        `slope mismatch at T=${T}`,
      );
    }
    if ('fittedNormalizedHead' in actual && 'fittedNormalizedHead' in expected) {
      assert.ok(
        Math.abs(actual.fittedNormalizedHead - expected.fittedNormalizedHead) <=
          1e-9 * Math.max(1, Math.abs(expected.fittedNormalizedHead)),
        `fit mismatch at T=${T}`,
      );
    }
  }
  void maxT;
});
