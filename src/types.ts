export const STAGE_COUNT = 4;

/** Funnel stage actions in order. Note stage 1 and 2 both require "click". */
export const STAGE_ACTIONS = ["impression", "click", "click", "conversion"] as const;

export type StageCounts = [number, number, number, number];

/** A single raw input event. Identity merge / journey splitting / dedup are out of scope. */
export interface FunnelEvent {
  customer: string | number;
  journey: string | number;
  action: string;
  /** UTC epoch milliseconds. */
  time: number;
  /** Tie-break order for events sharing the same millisecond. */
  seq: number;
}

/** Action ids used by the columnar input format. */
export const ACTION_IMPRESSION = 0;
export const ACTION_CLICK = 1;
export const ACTION_CONVERSION = 2;
export const ACTION_OTHER = 3;

/** Columnar (struct-of-arrays) input for large-scale preparation. */
export interface ColumnarEvents {
  count: number;
  customerCount: number;
  journeyCount: number;
  /** Numeric customer ids in [0, customerCount). */
  customer: ArrayLike<number>;
  /** Numeric journey ids in [0, journeyCount). */
  journey: ArrayLike<number>;
  /** ACTION_* ids. */
  action: ArrayLike<number>;
  /** UTC epoch milliseconds. */
  time: ArrayLike<number>;
  seq: ArrayLike<number>;
}

export type EventInput = Iterable<FunnelEvent> | ColumnarEvents;

/** Per-stage point set. A point (start, end, cust) means: this customer completes
 *  the stage for any window [S, E) with S <= start and end < E. */
export interface StageData {
  /** Number of points. */
  n: number;
  /** Chain start times (stage-1 event time), sorted ascending. */
  starts: Float64Array;
  /** Chain stage-completion times, aligned with `starts`. */
  ends: Float64Array;
  /** Customer ids, aligned with `starts`. */
  cust: Uint32Array;
  /** Same points, sorted by completion time ascending. */
  endsSorted: Float64Array;
  startsByEnd: Float64Array;
  custByEnd: Uint32Array;
}

export interface PreparedData {
  version: number;
  customerCount: number;
  journeyCount: number;
  eventCount: number;
  stages: StageData[];
}

export const PREPARED_VERSION = 1;
