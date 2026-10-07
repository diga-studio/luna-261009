import { LifeAssessment, TelemetryPoint } from '../src/types';

const MS_PER_HOUR = 3_600_000;
const WINDOW_MS = 30 * 24 * MS_PER_HOUR;
const HEAD_LIMIT = 0.8;
const MIN_DECLINE_PER_HOUR = 1e-6;

/**
 * Independent point-by-point recomputation of the spec, used as the
 * ground truth in tests. Shares no code with the library.
 */
export function naiveAssess(
  records: ReadonlyMap<number, TelemetryPoint>,
  ratedSpeed: number,
  ratedHead: number,
  atMs: number,
): LifeAssessment {
  const sorted = [...records.values()].sort(
    (x, y) => x.timestampMs - y.timestampMs,
  );
  return naiveAssessSorted(sorted, ratedSpeed, ratedHead, atMs);
}

/** Same as naiveAssess but takes an already time-sorted array. */
export function naiveAssessSorted(
  sorted: TelemetryPoint[],
  ratedSpeed: number,
  ratedHead: number,
  atMs: number,
): LifeAssessment {
  const n = sorted.length;
  const times = new Array<number>(n);
  // prefixOh[i] = operating hours accumulated over (-inf, times[i]).
  const prefixOh = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    times[i] = sorted[i].timestampMs;
    prefixOh[i] =
      i === 0
        ? 0
        : prefixOh[i - 1] +
          (sorted[i - 1].speed > 0
            ? (times[i] - times[i - 1]) / MS_PER_HOUR
            : 0);
  }

  // Cumulative operating hours over (-inf, t).
  const oh = (t: number): number => {
    // idx = last record with timestamp <= t
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo - 1;
    if (idx < 0) return 0;
    return (
      prefixOh[idx] +
      (sorted[idx].speed > 0 ? (t - times[idx]) / MS_PER_HOUR : 0)
    );
  };

  const L = atMs - WINDOW_MS;
  const c = oh(L);
  let cnt = 0;
  let Sx = 0;
  let Sy = 0;
  let Sxx = 0;
  let Sxy = 0;
  for (let i = 0; i < n; i++) {
    const r = sorted[i];
    if (r.timestampMs < L || r.timestampMs > atMs) continue;
    if (r.speed <= 0) continue;
    const ratio = r.speed / ratedSpeed;
    const x = prefixOh[i] - c;
    const y = r.head / (ratedHead * ratio * ratio);
    cnt++;
    Sx += x;
    Sy += y;
    Sxx += x * x;
    Sxy += x * y;
  }
  if (cnt < 2) return { status: 'insufficient-data' };

  const denom = cnt * Sxx - Sx * Sx;
  const slope = denom === 0 ? 0 : (cnt * Sxy - Sx * Sy) / denom;
  const meanX = Sx / cnt;
  const meanY = Sy / cnt;
  const fit = meanY + slope * (oh(atMs) - c - meanX);

  if (fit <= HEAD_LIMIT) {
    return {
      status: 'depleted',
      slope: slope,
      fittedNormalizedHead: fit,
      remainingOperatingHours: 0,
    };
  }
  const decline = -slope;
  if (!(decline > MIN_DECLINE_PER_HOUR)) {
    return {
      status: 'no-finite-estimate',
      slope: slope,
      fittedNormalizedHead: fit,
    };
  }
  return {
    status: 'finite',
    slope: slope,
    fittedNormalizedHead: fit,
    remainingOperatingHours: (fit - HEAD_LIMIT) / decline,
  };
}

/** Deterministic PRNG for reproducible tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
