import type { RulResult, TelemetryPoint } from '../src/types';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/**
 * 独立逐点重算的参考实现：直接按题面语义暴力计算，
 * 用于与被测库的高性能实现对照。
 */
export function referencePredict(
  ratedRpm: number,
  ratedHead: number,
  writes: readonly (readonly TelemetryPoint[])[],
  atMs: number,
): RulResult {
  const byTs = new Map<number, TelemetryPoint>();
  for (const batch of writes) {
    for (const p of batch) {
      byTs.set(p.timestampMs, p);
    }
  }
  const records = [...byTs.values()].sort((a, b) => a.timestampMs - b.timestampMs);

  // 每个记录生效区间的运行小时（区间 [ts_i, ts_{i+1})）。
  const runHoursBefore: number[] = new Array(records.length).fill(0);
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1]!;
    const cur = records[i]!;
    const delta = prev.rpm > 0 ? (cur.timestampMs - prev.timestampMs) / MS_PER_HOUR : 0;
    runHoursBefore[i] = runHoursBefore[i - 1]! + delta;
  }
  const hoursAt = (t: number): number => {
    // 最后一条 ts <= t 的记录。
    let idx = -1;
    for (let i = 0; i < records.length; i++) {
      if (records[i]!.timestampMs <= t) idx = i;
      else break;
    }
    if (idx < 0) return 0;
    const rec = records[idx]!;
    const partial = rec.rpm > 0 ? (t - rec.timestampMs) / MS_PER_HOUR : 0;
    return runHoursBefore[idx]! + partial;
  };

  const leftMs = atMs - 30 * MS_PER_DAY;
  const hLeft = hoursAt(leftMs);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const rec of records) {
    if (rec.timestampMs < leftMs || rec.timestampMs > atMs) continue;
    if (rec.rpm <= 0) continue;
    const expected = ratedHead * (rec.rpm / ratedRpm) ** 2;
    xs.push(hoursAt(rec.timestampMs) - hLeft);
    ys.push(rec.head / expected);
  }
  const n = xs.length;
  if (n < 2) return { status: 'insufficient-data' };

  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxy += xs[i]! * ys[i]!;
    sxx += xs[i]! * xs[i]!;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom > 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const fittedValue = intercept + slope * (hoursAt(atMs) - hLeft);

  if (fittedValue <= 0.8) {
    return { status: 'exhausted', slope, fittedValue, remainingLifeHours: 0 };
  }
  if (slope >= -0.000001) {
    return { status: 'no-finite-estimate', slope, fittedValue };
  }
  return {
    status: 'ok',
    slope,
    fittedValue,
    remainingLifeHours: (fittedValue - 0.8) / -slope,
  };
}

export function assertClose(
  actual: number,
  expected: number,
  relTol: number,
  label: string,
): void {
  const diff = Math.abs(actual - expected);
  const scale = Math.max(Math.abs(expected), 1e-12);
  if (!(diff <= relTol * scale || diff <= 1e-12)) {
    throw new Error(
      `${label}: actual=${actual} expected=${expected} relErr=${diff / scale}`,
    );
  }
}

export function assertSameResult(
  actual: RulResult,
  expected: RulResult,
  label: string,
): void {
  if (actual.status !== expected.status) {
    throw new Error(
      `${label}: status ${actual.status} != ${expected.status} ` +
        `(actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`,
    );
  }
  if (actual.status === 'insufficient-data') return;
  const e = expected as Exclude<RulResult, { status: 'insufficient-data' }>;
  assertClose(actual.slope, e.slope, 1e-9, `${label} slope`);
  assertClose(actual.fittedValue, e.fittedValue, 1e-9, `${label} fittedValue`);
  if (actual.status === 'ok' && e.status === 'ok') {
    assertClose(
      actual.remainingLifeHours,
      e.remainingLifeHours,
      1e-6,
      `${label} remainingLifeHours`,
    );
  }
}

/** 可增量写入的参考实现：暴力维护有序记录，查询时逐点重算。 */
export class ReferenceTwin {
  private readonly byTs = new Map<number, TelemetryPoint>();
  private sorted: TelemetryPoint[] | null = null;

  constructor(
    private readonly ratedRpm: number,
    private readonly ratedHead: number,
  ) {}

  writeBatch(points: readonly TelemetryPoint[]): void {
    for (const p of points) {
      this.byTs.set(p.timestampMs, p);
    }
    this.sorted = null;
  }

  predict(atMs: number): RulResult {
    if (this.sorted === null) {
      this.sorted = [...this.byTs.values()].sort(
        (a, b) => a.timestampMs - b.timestampMs,
      );
    }
    const records = this.sorted;
    const runHoursBefore: number[] = new Array(records.length).fill(0);
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1]!;
      const cur = records[i]!;
      const delta =
        prev.rpm > 0 ? (cur.timestampMs - prev.timestampMs) / MS_PER_HOUR : 0;
      runHoursBefore[i] = runHoursBefore[i - 1]! + delta;
    }
    const hoursAt = (t: number): number => {
      let lo = 0, hi = records.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (records[mid]!.timestampMs <= t) lo = mid + 1;
        else hi = mid;
      }
      const idx = lo - 1;
      if (idx < 0) return 0;
      const rec = records[idx]!;
      const partial = rec.rpm > 0 ? (t - rec.timestampMs) / MS_PER_HOUR : 0;
      return runHoursBefore[idx]! + partial;
    };
    const leftMs = atMs - 30 * MS_PER_DAY;
    const hLeft = hoursAt(leftMs);
    let n = 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      if (rec.timestampMs < leftMs || rec.timestampMs > atMs) continue;
      if (rec.rpm <= 0) continue;
      const expected = this.ratedHead * (rec.rpm / this.ratedRpm) ** 2;
      const x = runHoursBefore[i]! - hLeft;
      const y = rec.head / expected;
      n++;
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    }
    if (n < 2) return { status: 'insufficient-data' };
    const denom = n * sxx - sx * sx;
    const slope = denom > 0 ? (n * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / n;
    const fittedValue = intercept + slope * (hoursAt(atMs) - hLeft);
    if (fittedValue <= 0.8) {
      return { status: 'exhausted', slope, fittedValue, remainingLifeHours: 0 };
    }
    if (slope >= -0.000001) {
      return { status: 'no-finite-estimate', slope, fittedValue };
    }
    return {
      status: 'ok',
      slope,
      fittedValue,
      remainingLifeHours: (fittedValue - 0.8) / -slope,
    };
  }
}
