import {
  ACTION_CLICK,
  ACTION_CONVERSION,
  ACTION_IMPRESSION,
  ACTION_OTHER,
  ColumnarEvents,
} from "../src/types";

export interface BenchScale {
  events: number;
  customers: number;
  journeys: number;
  queries: number;
}

export const FULL_SCALE: BenchScale = {
  events: 10_000_000,
  customers: 500_000,
  journeys: 2_000_000,
  queries: 10_000,
};

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

const DAY_MS = 24 * 3600 * 1000;
export const SPAN_MS = 365 * DAY_MS;
export const BASE_TIME = 1_700_000_000_000; // fixed epoch base, deterministic

/**
 * Deterministically generate the benchmark event set: 10M events, 500K
 * customers, 2M journeys over 365 days, with duplicate actions, overlapping
 * journeys and dense multi-event-per-ms bursts.
 */
export function generateEvents(scale: BenchScale, seed = 20261007): ColumnarEvents {
  const rand = mulberry32(seed);
  const n = scale.events;
  const time = new Float64Array(n);
  const customer = new Uint32Array(n);
  const journey = new Uint32Array(n);
  const seq = new Uint32Array(n);
  const action = new Uint8Array(n);

  // Dense burst centers: journeys started here pack many events per ms.
  const burstCount = 300;
  const bursts = new Float64Array(burstCount);
  for (let b = 0; b < burstCount; b++) {
    bursts[b] = BASE_TIME + Math.floor(rand() * SPAN_MS);
  }

  let i = 0;
  let j = 0;
  while (i < n && j < scale.journeys) {
    const cust = Math.floor(rand() * scale.customers);
    // 15% of journeys start inside a dense burst (1-minute window).
    let t: number;
    if (rand() < 0.15) {
      const center = bursts[Math.floor(rand() * burstCount)];
      t = center + Math.floor(rand() * 60_000);
    } else {
      t = BASE_TIME + Math.floor(rand() * SPAN_MS);
    }
    // Journey composition.
    const r = rand();
    let pattern: number[];
    if (r < 0.35) {
      pattern = [ACTION_IMPRESSION, ACTION_CLICK, ACTION_CLICK, ACTION_CONVERSION];
    } else if (r < 0.55) {
      pattern = [ACTION_IMPRESSION, ACTION_CLICK];
    } else if (r < 0.7) {
      pattern = [ACTION_IMPRESSION, ACTION_CLICK, ACTION_CLICK];
    } else if (r < 0.8) {
      pattern = [ACTION_IMPRESSION];
    } else {
      // Random actions, may or may not form chains.
      const m = 1 + Math.floor(rand() * 5);
      pattern = [];
      for (let k = 0; k < m; k++) {
        pattern.push(Math.floor(rand() * 4));
      }
    }
    const inBurst = t < BASE_TIME + SPAN_MS && rand() < 0.3;
    let s = 0;
    for (const a of pattern) {
      if (i >= n) break;
      time[i] = t;
      customer[i] = cust;
      journey[i] = j;
      seq[i] = s++;
      action[i] = a;
      i++;
      // Gap to next event: dense inside bursts, wider otherwise.
      const gap = inBurst
        ? Math.floor(rand() * 3) // 0..2 ms, same-ms collisions
        : 1 + Math.floor(rand() * rand() * 60_000);
      t += gap;
      // Occasional noise event between funnel actions.
      if (i < n && rand() < 0.15) {
        time[i] = t;
        customer[i] = cust;
        journey[i] = j;
        seq[i] = s++;
        action[i] = ACTION_OTHER;
        i++;
        t += 1 + Math.floor(rand() * 1000);
      }
    }
    j++;
  }
  // If journeys ran out before events, top up with noise journeys.
  while (i < n) {
    const cust = Math.floor(rand() * scale.customers);
    time[i] = BASE_TIME + Math.floor(rand() * SPAN_MS);
    customer[i] = cust;
    journey[i] = j % scale.journeys;
    seq[i] = 100 + Math.floor(rand() * 100);
    action[i] = ACTION_OTHER;
    i++;
  }
  return {
    count: n,
    customerCount: scale.customers,
    journeyCount: scale.journeys,
    customer,
    journey,
    action,
    time,
    seq,
  };
}

/**
 * Generate the query workload: 100 warmup + `scale.queries` timed queries,
 * mimicking an analyst dragging a timeline: consecutive windows overlap
 * heavily and endpoints usually move by a few ms; ~1% of queries jump to a
 * new position. 80%+ of windows cover 50-90% of all events. All windows are
 * distinct, with distinct first/last contained-event combinations. Endpoints
 * are arbitrary milliseconds, not aligned to event times.
 */
export function generateQueries(
  scale: BenchScale,
  sortedTimes: Float64Array,
  seed = 77001
): { warmup: [number, number][]; timed: [number, number][] } {
  const rand = mulberry32(seed);
  const n = sortedTimes.length;
  const timeAt = (q: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)));
    return sortedTimes[idx];
  };
  const firstEventIdx = (s: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedTimes[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const used = new Set<string>();
  const usedEventPair = new Set<string>();

  const tryEmit = (s: number, e: number, out: [number, number][]): boolean => {
    if (!(s < e)) return false;
    const key = `${s},${e}`;
    if (used.has(key)) return false;
    const pair = `${firstEventIdx(s)},${firstEventIdx(e)}`;
    if (usedEventPair.has(pair)) return false;
    used.add(key);
    usedEventPair.add(pair);
    out.push([s, e]);
    return true;
  };

  const timed: [number, number][] = [];
  const wideTarget = Math.ceil(scale.queries * 0.8);

  // Sliding run: emit consecutive windows whose endpoints move by small
  // random amounts (a few ms, occasionally more). Step size grows until the
  // contained first/last event combination changes.
  const slideRun = (
    s0: number,
    width: number,
    jitterWidth: boolean,
    budget: number
  ): void => {
    let s = s0;
    let w = width;
    let emitted = 0;
    let guard = 0;
    while (emitted < budget && guard++ < budget * 50) {
      if (tryEmit(s, s + w, timed)) emitted++;
      // Move endpoints by a few ms (sometimes up to a minute).
      const step = rand() < 0.85 ? 1 + Math.floor(rand() * 8) : 1 + Math.floor(rand() * 60_000);
      const ds = rand() < 0.5 ? step : -step;
      const de = rand() < 0.5 ? step : -step;
      s += ds;
      if (jitterWidth) w = Math.max(10, w + de);
    }
  };

  // Wide windows (covering 50-90% of events) dragged across the timeline.
  while (timed.length < wideTarget) {
    const q0 = 0.02 + rand() * 0.38;
    const wFrac = 0.5 + rand() * 0.4;
    const q1 = Math.min(0.99, q0 + wFrac);
    const s = timeAt(q0) - Math.floor(rand() * 977);
    const e = timeAt(q1) + 1 + Math.floor(rand() * 613);
    const width = e - s;
    const runLen = Math.min(wideTarget - timed.length, 20 + Math.floor(rand() * 80));
    slideRun(s, width, false, runLen);
  }
  // Narrow windows sliding through dense fragments.
  while (timed.length < scale.queries) {
    const center = timeAt(0.1 + rand() * 0.8);
    const s = center - Math.floor(rand() * 2000);
    const width = 50 + Math.floor(rand() * 5000);
    const runLen = Math.min(scale.queries - timed.length, 20 + Math.floor(rand() * 80));
    slideRun(s, width, true, runLen);
  }

  const warmup: [number, number][] = [];
  // Warmup windows: wide, sliding in short runs (distinct from timed set).
  while (warmup.length < 100) {
    const q0 = 0.05 + rand() * 0.35;
    const q1 = Math.min(0.99, q0 + 0.5 + rand() * 0.4);
    let s = timeAt(q0) - Math.floor(rand() * 977);
    const width = timeAt(q1) + 1 + Math.floor(rand() * 613) - s;
    const runLen = Math.min(100 - warmup.length, 10);
    let emitted = 0;
    let guard = 0;
    while (emitted < runLen && guard++ < runLen * 50) {
      if (tryEmit(s, s + width, warmup)) emitted++;
      s += 1 + Math.floor(rand() * 8);
    }
  }
  return { warmup, timed };
}
