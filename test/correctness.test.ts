import assert from 'node:assert/strict';
import test from 'node:test';
import { PumpTwin } from '../src/index';
import { LifeAssessment } from '../src/types';

const H = 3_600_000;

function assertClose(actual: number, expected: number, eps = 1e-9): void {
  const tol = eps * Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );
}

test('empty twin reports insufficient data', () => {
  const twin = new PumpTwin(1000, 50);
  assert.equal(twin.assessRemainingLife(0).status, 'insufficient-data');
});

test('single running record is insufficient', () => {
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([{ timestampMs: 0, speed: 1000, head: 50 }]);
  assert.equal(twin.assessRemainingLife(24 * H).status, 'insufficient-data');
});

test('query before the first record is insufficient', () => {
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 10 * H, speed: 1000, head: 50 },
    { timestampMs: 20 * H, speed: 1000, head: 49 },
  ]);
  assert.equal(twin.assessRemainingLife(5 * H).status, 'insufficient-data');
});

test('hand-computed linear degradation without stops', () => {
  // t=0h: y=1.0, t=12h: y=0.92, both running at rated speed.
  // slope = -0.08/12 = -1/150 per hour; xT at T=24h is 24h.
  // fit = 0.96 - (1/150)*(24-6) = 0.84; RUL = (0.84-0.8)*150 = 6h.
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 0, speed: 1000, head: 50 },
    { timestampMs: 12 * H, speed: 1000, head: 46 },
  ]);
  const r = twin.assessRemainingLife(24 * H);
  assert.equal(r.status, 'finite');
  if (r.status !== 'finite') return;
  assertClose(r.slope, -1 / 150);
  assertClose(r.fittedNormalizedHead, 0.84);
  assertClose(r.remainingOperatingHours, 6);
});

test('hand-computed degradation with a stopped interval', () => {
  // t=0h run y=1.0; t=6h stop; t=12h run y=0.92; T=24h.
  // Operating hours: x0=0, x1=6 (stop does not count), xT=6+12=18.
  // slope = -0.08/6 = -1/75; fit = 0.96 - (1/75)*(18-3) = 0.76 <= 0.8.
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 0, speed: 1000, head: 50 },
    { timestampMs: 6 * H, speed: 0, head: 0 },
    { timestampMs: 12 * H, speed: 1000, head: 46 },
  ]);
  const r = twin.assessRemainingLife(24 * H);
  assert.equal(r.status, 'depleted');
  if (r.status !== 'depleted') return;
  assertClose(r.slope, -1 / 75);
  assertClose(r.fittedNormalizedHead, 0.76);
  assert.equal(r.remainingOperatingHours, 0);
});

test('constant health under frequent speed changes has no finite estimate', () => {
  const ratedSpeed = 3000;
  const ratedHead = 100;
  const twin = new PumpTwin(ratedSpeed, ratedHead);
  const points = [];
  let speed = 1200;
  for (let i = 0; i < 2000; i++) {
    speed = 1000 + ((i * 137) % 2000); // frequent speed changes
    const ratio = speed / ratedSpeed;
    points.push({
      timestampMs: i * H,
      speed,
      head: ratedHead * ratio * ratio, // actual head always equals expected
    });
  }
  twin.writeTelemetry(points);
  const r = twin.assessRemainingLife(2000 * H);
  assert.equal(r.status, 'no-finite-estimate');
  if (r.status !== 'no-finite-estimate') return;
  assertClose(r.fittedNormalizedHead, 1, 1e-9);
  assert.ok(Math.abs(r.slope) <= 1e-6);
});

test('improving health has no finite estimate', () => {
  const twin = new PumpTwin(1000, 50);
  const points = [];
  for (let i = 0; i <= 48; i++) {
    points.push({ timestampMs: i * H, speed: 1000, head: 40 + i * 0.1 });
  }
  twin.writeTelemetry(points);
  const r = twin.assessRemainingLife(48 * H);
  assert.equal(r.status, 'no-finite-estimate');
});

test('duplicate timestamps in one batch: last write wins', () => {
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 0, speed: 1000, head: 50 },
    { timestampMs: 12 * H, speed: 0, head: 0 },
    { timestampMs: 12 * H, speed: 1000, head: 46 },
  ]);
  // Same as the no-stop case: RUL 6h at T=24h.
  const r = twin.assessRemainingLife(24 * H);
  assert.equal(r.status, 'finite');
  if (r.status !== 'finite') return;
  assertClose(r.remainingOperatingHours, 6);
});

test('records after T must not affect the result', () => {
  const make = (): PumpTwin => {
    const twin = new PumpTwin(1000, 50);
    twin.writeTelemetry([
      { timestampMs: 0, speed: 1000, head: 50 },
      { timestampMs: 12 * H, speed: 1000, head: 46 },
    ]);
    return twin;
  };
  const baseline = make().assessRemainingLife(24 * H);
  const withFuture = make();
  withFuture.writeTelemetry([
    { timestampMs: 36 * H, speed: 1000, head: 1 },
    { timestampMs: 48 * H, speed: 2000, head: 1 },
  ]);
  const r = withFuture.assessRemainingLife(24 * H);
  assert.equal(r.status, baseline.status);
  if (r.status === 'finite' && baseline.status === 'finite') {
    assertClose(r.slope, baseline.slope, 1e-12);
    assertClose(r.fittedNormalizedHead, baseline.fittedNormalizedHead, 1e-12);
    assertClose(
      r.remainingOperatingHours,
      baseline.remainingOperatingHours,
      1e-12,
    );
  }
});

test('window excludes records older than 30 days before T', () => {
  const twin = new PumpTwin(1000, 50);
  // Old degraded segment 40..31 days before T (outside the window).
  const points = [];
  for (let i = 0; i <= 9; i++) {
    points.push({ timestampMs: i * 24 * H, speed: 1000, head: 10 });
  }
  // Fresh healthy segment inside the window: constant y = 1.
  for (let i = 10; i <= 40; i++) {
    points.push({ timestampMs: i * 24 * H, speed: 1000, head: 50 });
  }
  twin.writeTelemetry(points);
  const r = twin.assessRemainingLife(40 * 24 * H);
  // Window is [10d, 40d]; all points inside have y = 1.
  assert.equal(r.status, 'no-finite-estimate');
  if (r.status !== 'no-finite-estimate') return;
  assertClose(r.fittedNormalizedHead, 1, 1e-9);
});

test('invalid constructor arguments throw', () => {
  assert.throws(() => new PumpTwin(0, 50));
  assert.throws(() => new PumpTwin(1000, -1));
  assert.throws(() => new PumpTwin(NaN, 50));
});

test('invalid telemetry fields throw', () => {
  const twin = new PumpTwin(1000, 50);
  assert.throws(() =>
    twin.writeTelemetry([{ timestampMs: NaN, speed: 1, head: 1 }]),
  );
});

test('result type narrows expose expected fields', () => {
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 0, speed: 1000, head: 50 },
    { timestampMs: 12 * H, speed: 1000, head: 46 },
  ]);
  const r: LifeAssessment = twin.assessRemainingLife(24 * H);
  if (r.status === 'finite') {
    assert.ok(r.remainingOperatingHours > 0);
  } else {
    assert.fail('expected finite');
  }
});

test('record exactly at T is included in the window', () => {
  // t=0h run y=1.0; t=24h run y=0.92; T=24h exactly.
  // slope = -0.08/24 = -1/300; fit at xT=24h: 0.96 - 12/300 = 0.92.
  // RUL = (0.92 - 0.8) * 300 = 36 operating hours.
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 0, speed: 1000, head: 50 },
    { timestampMs: 24 * H, speed: 1000, head: 46 },
  ]);
  const r = twin.assessRemainingLife(24 * H);
  assert.equal(r.status, 'finite');
  if (r.status !== 'finite') return;
  assertClose(r.slope, -1 / 300);
  assertClose(r.fittedNormalizedHead, 0.92);
  assertClose(r.remainingOperatingHours, 36);
});

test('record exactly at the window left edge is included', () => {
  // t=0h run (outside window); t=24h run y=0.95; t=48h run y=0.92.
  // T = 30d + 24h, so L = 24h exactly: the t=24h record sits on the edge.
  // Two fitting points -> not insufficient; fit at xT=720h is far below 0.8.
  const twin = new PumpTwin(1000, 50);
  twin.writeTelemetry([
    { timestampMs: 0, speed: 1000, head: 50 },
    { timestampMs: 24 * H, speed: 1000, head: 47.5 },
    { timestampMs: 48 * H, speed: 1000, head: 46 },
  ]);
  const r = twin.assessRemainingLife(30 * 24 * H + 24 * H);
  assert.equal(r.status, 'depleted');
  if (r.status !== 'depleted') return;
  assertClose(r.slope, -0.03 / 24);
  assertClose(r.fittedNormalizedHead, 0.935 - (0.03 / 24) * (720 - 12));
});
