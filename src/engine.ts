import { PreparedData, STAGE_COUNT, StageCounts, StageData } from "./types";
import { lowerBoundF64 } from "./sort";

/**
 * Query engine over prepared data. Answers windowed funnel queries:
 * for window [startMs, endMs), returns per-stage distinct customer counts.
 *
 * A customer completes stage k iff one of their chain points (start, end)
 * satisfies start >= S && end < E. The engine tracks per-customer reference
 * counts of points inside the current quadrant and updates them
 * incrementally as the window moves, so overlapping/sliding windows cost
 * proportional to the endpoint movement, not the window width.
 */
export class FunnelEngine {
  private data: PreparedData;
  private customerCount: number;
  private refs: Uint32Array[] = [];
  private counts: number[] = new Array(STAGE_COUNT).fill(0);
  private curS = 0;
  private curE = 0;
  private initialized = false;

  /** Delta cost above which a full recompute is cheaper than incremental update. */
  private static readonly INCREMENTAL_THRESHOLD = 400_000;

  constructor(data: PreparedData) {
    this.data = data;
    this.customerCount = data.customerCount;
    for (let k = 0; k < STAGE_COUNT; k++) {
      this.refs.push(new Uint32Array(this.customerCount));
    }
  }

  query(startMs: number, endMs: number): StageCounts {
    if (!this.initialized) {
      this.fullInit(startMs, endMs);
      this.initialized = true;
    } else {
      if (this.estimateDeltaCost(startMs, endMs) > FunnelEngine.INCREMENTAL_THRESHOLD) {
        this.fullInit(startMs, endMs);
        return [this.counts[0], this.counts[1], this.counts[2], this.counts[3]];
      }
      for (let k = 0; k < STAGE_COUNT; k++) {
        const stage = this.data.stages[k];
        this.moveStart(stage, this.refs[k], k, this.curS, startMs, this.curE);
        this.moveEnd(stage, this.refs[k], k, this.curE, endMs, startMs);
      }
      this.curS = startMs;
      this.curE = endMs;
    }
    return [this.counts[0], this.counts[1], this.counts[2], this.counts[3]];
  }

  /** Number of chain points whose quadrant membership may change. */
  private estimateDeltaCost(S: number, E: number): number {
    let cost = 0;
    for (let k = 0; k < STAGE_COUNT; k++) {
      const stage = this.data.stages[k];
      const a = lowerBoundF64(stage.starts, Math.min(this.curS, S));
      const b = lowerBoundF64(stage.starts, Math.max(this.curS, S));
      cost += b - a;
      const c = lowerBoundF64(stage.endsSorted, Math.min(this.curE, E));
      const d = lowerBoundF64(stage.endsSorted, Math.max(this.curE, E));
      cost += d - c;
    }
    return cost;
  }

  private fullInit(S: number, E: number): void {
    for (let k = 0; k < STAGE_COUNT; k++) {
      const stage = this.data.stages[k];
      const refs = this.refs[k];
      refs.fill(0);
      let count = 0;
      const starts = stage.starts;
      const ends = stage.ends;
      const cust = stage.cust;
      const from = lowerBoundF64(starts, S);
      for (let i = from; i < stage.n; i++) {
        if (ends[i] < E) {
          const c = cust[i];
          if (refs[c] === 0) count++;
          refs[c]++;
        }
      }
      this.counts[k] = count;
    }
    this.curS = S;
    this.curE = E;
  }

  /** Move the left edge oldS -> newS, keeping right edge E fixed. */
  private moveStart(
    stage: StageData,
    refs: Uint32Array,
    stageIdx: number,
    oldS: number,
    newS: number,
    E: number
  ): void {
    if (newS === oldS) return;
    const starts = stage.starts;
    const ends = stage.ends;
    const cust = stage.cust;
    let count = this.counts[stageIdx];
    if (newS > oldS) {
      // Points with start in [oldS, newS) leave the quadrant.
      const hi = lowerBoundF64(starts, newS);
      for (let i = lowerBoundF64(starts, oldS); i < hi; i++) {
        if (ends[i] < E) {
          const c = cust[i];
          refs[c]--;
          if (refs[c] === 0) count--;
        }
      }
    } else {
      // Points with start in [newS, oldS) enter the quadrant.
      const hi = lowerBoundF64(starts, oldS);
      for (let i = lowerBoundF64(starts, newS); i < hi; i++) {
        if (ends[i] < E) {
          const c = cust[i];
          if (refs[c] === 0) count++;
          refs[c]++;
        }
      }
    }
    this.counts[stageIdx] = count;
  }

  /** Move the right edge oldE -> newE, keeping left edge S fixed. */
  private moveEnd(
    stage: StageData,
    refs: Uint32Array,
    stageIdx: number,
    oldE: number,
    newE: number,
    S: number
  ): void {
    if (newE === oldE) return;
    const ends = stage.endsSorted;
    const starts = stage.startsByEnd;
    const cust = stage.custByEnd;
    let count = this.counts[stageIdx];
    if (newE > oldE) {
      // Points with end in [oldE, newE) enter the quadrant.
      const hi = lowerBoundF64(ends, newE);
      for (let i = lowerBoundF64(ends, oldE); i < hi; i++) {
        if (starts[i] >= S) {
          const c = cust[i];
          if (refs[c] === 0) count++;
          refs[c]++;
        }
      }
    } else {
      // Points with end in [newE, oldE) leave the quadrant.
      const hi = lowerBoundF64(ends, oldE);
      for (let i = lowerBoundF64(ends, newE); i < hi; i++) {
        if (starts[i] >= S) {
          const c = cust[i];
          refs[c]--;
          if (refs[c] === 0) count--;
        }
      }
    }
    this.counts[stageIdx] = count;
  }
}
