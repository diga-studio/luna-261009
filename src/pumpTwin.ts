import { IDENTITY, NodeAgg, SegmentTree } from './segmentTree';
import { LifeAssessment, TelemetryPoint } from './types';

const MS_PER_HOUR = 3_600_000;
const WINDOW_MS = 30 * 24 * MS_PER_HOUR;
const HEAD_LIMIT = 0.8;
const MIN_DECLINE_PER_HOUR = 1e-6;

function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Digital twin of a single pump. Telemetry lives in process memory.
 * Expected head at speed n: ratedHead * (n / ratedSpeed)^2.
 */
export class PumpTwin {
  private readonly ratedSpeed: number;
  private readonly ratedHead: number;
  private times: number[] = [];
  private speeds: number[] = [];
  private heads: number[] = [];
  private indexOf = new Map<number, number>();
  private tree: SegmentTree | null = null;

  constructor(ratedSpeed: number, ratedHead: number) {
    if (!Number.isFinite(ratedSpeed) || ratedSpeed <= 0) {
      throw new TypeError('ratedSpeed must be a positive finite number');
    }
    if (!Number.isFinite(ratedHead) || ratedHead <= 0) {
      throw new TypeError('ratedHead must be a positive finite number');
    }
    this.ratedSpeed = ratedSpeed;
    this.ratedHead = ratedHead;
  }

  /**
   * Batch write. Timestamps may arrive out of order; re-writing an existing
   * timestamp replaces the whole record (last write wins, in batch order).
   */
  writeTelemetry(points: TelemetryPoint[]): void {
    const pending: TelemetryPoint[] = [];
    const pendingIdx = new Map<number, number>();
    for (const p of points) {
      if (
        !Number.isFinite(p.timestampMs) ||
        !Number.isFinite(p.speed) ||
        !Number.isFinite(p.head)
      ) {
        throw new TypeError('telemetry fields must be finite numbers');
      }
      const existing = this.indexOf.get(p.timestampMs);
      if (existing !== undefined) {
        this.speeds[existing] = p.speed;
        this.heads[existing] = p.head;
        this.tree!.setLeaf(existing, this.leafFor(existing));
      } else {
        const slot = pendingIdx.get(p.timestampMs);
        if (slot !== undefined) {
          pending[slot] = p;
        } else {
          pendingIdx.set(p.timestampMs, pending.length);
          pending.push(p);
        }
      }
    }
    if (pending.length > 0) this.insertNew(pending);
  }

  /** Assess remaining life at time T using the window [T-30d, T] (inclusive). */
  assessRemainingLife(atMs: number): LifeAssessment {
    const n = this.times.length;
    if (n === 0) return { status: 'insufficient-data' };

    const L = atMs - WINDOW_MS;
    const a = lowerBound(this.times, L);
    const b = upperBound(this.times, atMs) - 1;
    if (a > b) return { status: 'insufficient-data' };

    const win = this.tree!.query(a, b);
    const cnt = win.cnt;
    if (cnt < 2) return { status: 'insufficient-data' };

    // p = cumulative operating hours up to times[a] (exclusive of its interval).
    const p = a > 0 ? this.tree!.query(0, a - 1).sumD : 0;

    // c = cumulative operating hours up to the window left edge L.
    let c: number;
    if (a === 0 && this.times[0] > L) {
      c = 0;
    } else if (this.times[a] === L) {
      c = p;
    } else {
      const runningAtL = this.speeds[a - 1] > 0 ? 1 : 0;
      c = p - (runningAtL * (this.times[a] - L)) / MS_PER_HOUR;
    }

    // xT = cumulative operating hours from L up to T.
    const rb = this.speeds[b] > 0 ? 1 : 0;
    const db =
      rb === 1 && b + 1 < n
        ? (this.times[b + 1] - this.times[b]) / MS_PER_HOUR
        : 0;
    const ohT = p + win.sumD - db + (rb * (atMs - this.times[b])) / MS_PER_HOUR;
    const xT = ohT - c;

    // Least squares over x_i = P_i - c, y_i, with P_i = p + localP_i.
    const SP = p * cnt + win.sumRP;
    const SP2 = p * p * cnt + 2 * p * win.sumRP + win.sumRP2;
    const SPY = p * win.sumY + win.sumRPY;
    const SY = win.sumY;
    const Sx = SP - cnt * c;
    const Sxx = SP2 - 2 * c * SP + cnt * c * c;
    const Sxy = SPY - c * SY;
    const denom = cnt * Sxx - Sx * Sx;
    const slope = denom === 0 ? 0 : (cnt * Sxy - Sx * SY) / denom;
    const meanX = Sx / cnt;
    const meanY = SY / cnt;
    const fit = meanY + slope * (xT - meanX);

    if (fit <= HEAD_LIMIT) {
      return {
        status: 'depleted',
        slope,
        fittedNormalizedHead: fit,
        remainingOperatingHours: 0,
      };
    }
    const decline = -slope;
    if (!(decline > MIN_DECLINE_PER_HOUR)) {
      return { status: 'no-finite-estimate', slope, fittedNormalizedHead: fit };
    }
    return {
      status: 'finite',
      slope,
      fittedNormalizedHead: fit,
      remainingOperatingHours: (fit - HEAD_LIMIT) / decline,
    };
  }

  private expectedHead(speed: number): number {
    const ratio = speed / this.ratedSpeed;
    return this.ratedHead * ratio * ratio;
  }

  private leafFor(i: number): NodeAgg {
    const running = this.speeds[i] > 0;
    const d =
      running && i + 1 < this.times.length
        ? (this.times[i + 1] - this.times[i]) / MS_PER_HOUR
        : 0;
    const y = running ? this.heads[i] / this.expectedHead(this.speeds[i]) : 0;
    return { ...IDENTITY, cnt: running ? 1 : 0, sumD: d, sumY: y };
  }

  private insertNew(pending: TelemetryPoint[]): void {
    const merged = new Array<{ t: number; speed: number; head: number }>(
      this.times.length + pending.length,
    );
    let k = 0;
    for (let i = 0; i < this.times.length; i++) {
      merged[k++] = { t: this.times[i], speed: this.speeds[i], head: this.heads[i] };
    }
    for (const p of pending) {
      merged[k++] = { t: p.timestampMs, speed: p.speed, head: p.head };
    }
    merged.sort((x, y) => x.t - y.t);
    this.times = new Array(merged.length);
    this.speeds = new Array(merged.length);
    this.heads = new Array(merged.length);
    this.indexOf = new Map();
    for (let i = 0; i < merged.length; i++) {
      this.times[i] = merged[i].t;
      this.speeds[i] = merged[i].speed;
      this.heads[i] = merged[i].head;
      this.indexOf.set(merged[i].t, i);
    }
    this.tree = new SegmentTree(merged.length);
    const leaves = new Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      leaves[i] = this.leafFor(i);
    }
    this.tree.load(leaves);
  }
}
