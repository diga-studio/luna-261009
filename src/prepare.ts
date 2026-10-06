import {
  ACTION_CLICK,
  ACTION_CONVERSION,
  ACTION_IMPRESSION,
  ACTION_OTHER,
  ColumnarEvents,
  EventInput,
  FunnelEvent,
  PreparedData,
  PREPARED_VERSION,
  STAGE_COUNT,
  StageData,
} from "./types";
import {
  countingSortIndices,
  countingSortIndicesInPlace,
  radixSortIndicesByF64,
} from "./sort";

const ACTION_NAME_TO_ID: Record<string, number> = {
  impression: ACTION_IMPRESSION,
  click: ACTION_CLICK,
  conversion: ACTION_CONVERSION,
};

function isColumnar(input: EventInput): input is ColumnarEvents {
  return (
    typeof input === "object" &&
    input !== null &&
    "count" in input &&
    "customer" in input &&
    "time" in input
  );
}

/** Normalize any supported input into columnar numeric form. */
export function normalizeEvents(input: EventInput): ColumnarEvents {
  if (isColumnar(input)) return input;
  const customerIds = new Map<string | number, number>();
  const journeyIds = new Map<string | number, number>();
  const customer: number[] = [];
  const journey: number[] = [];
  const action: number[] = [];
  const time: number[] = [];
  const seq: number[] = [];
  for (const ev of input as Iterable<FunnelEvent>) {
    let cid = customerIds.get(ev.customer);
    if (cid === undefined) {
      cid = customerIds.size;
      customerIds.set(ev.customer, cid);
    }
    let jid = journeyIds.get(ev.journey);
    if (jid === undefined) {
      jid = journeyIds.size;
      journeyIds.set(ev.journey, jid);
    }
    const aid = ACTION_NAME_TO_ID[ev.action];
    customer.push(cid);
    journey.push(jid);
    action.push(aid === undefined ? ACTION_OTHER : aid);
    time.push(ev.time);
    seq.push(ev.seq);
  }
  const n = customer.length;
  return {
    count: n,
    customerCount: customerIds.size,
    journeyCount: journeyIds.size,
    customer: Uint32Array.from(customer),
    journey: Uint32Array.from(journey),
    action: Uint8Array.from(action),
    time: Float64Array.from(time),
    seq: Uint32Array.from(seq),
  };
}

/** Growable chunked output for chain points of one stage. */
class PointSink {
  starts: number[] = [];
  ends: number[] = [];
  custs: number[] = [];
  push(start: number, end: number, cust: number): void {
    this.starts.push(start);
    this.ends.push(end);
    this.custs.push(cust);
  }
  get size(): number {
    return this.starts.length;
  }
}

/**
 * Per customer, keep only Pareto-optimal points: a point is useless if the
 * same customer has another point with start' >= start and end' <= end.
 * Input arrays are grouped by customer (contiguous segments).
 */
function frontierFilter(
  starts: Float64Array,
  ends: Float64Array,
  cust: Uint32Array,
  customerCount: number
): { starts: Float64Array; ends: Float64Array; cust: Uint32Array } {
  const n = starts.length;
  const outStarts: number[] = [];
  const outEnds: number[] = [];
  const outCust: number[] = [];
  // Segment boundaries per customer (input sorted by cust).
  let segStart = 0;
  const order = new Uint32Array(64); // per-segment scratch, grown as needed
  let scratch = order;
  while (segStart < n) {
    const c = cust[segStart];
    let segEnd = segStart + 1;
    while (segEnd < n && cust[segEnd] === c) segEnd++;
    const m = segEnd - segStart;
    if (scratch.length < m) scratch = new Uint32Array(m * 2);
    for (let i = 0; i < m; i++) scratch[i] = segStart + i;
    // Sort segment by (start asc, end asc). Segments are tiny: insertion sort.
    for (let i = 1; i < m; i++) {
      const idx = scratch[i];
      const s = starts[idx];
      const e = ends[idx];
      let j = i - 1;
      while (
        j >= 0 &&
        (starts[scratch[j]] > s || (starts[scratch[j]] === s && ends[scratch[j]] > e))
      ) {
        scratch[j + 1] = scratch[j];
        j--;
      }
      scratch[j + 1] = idx;
    }
    // Scan right to left, keep strictly decreasing end values.
    let minEnd = Infinity;
    for (let i = m - 1; i >= 0; i--) {
      const idx = scratch[i];
      const e = ends[idx];
      if (e < minEnd) {
        minEnd = e;
        scratch[i] = idx | 0x80000000; // mark kept (indices < 2^31)
      }
    }
    for (let i = 0; i < m; i++) {
      const marked = scratch[i];
      if (marked & 0x80000000) {
        const idx = marked & 0x7fffffff;
        outStarts.push(starts[idx]);
        outEnds.push(ends[idx]);
        outCust.push(c);
      }
    }
    segStart = segEnd;
  }
  void customerCount;
  return {
    starts: Float64Array.from(outStarts),
    ends: Float64Array.from(outEnds),
    cust: Uint32Array.from(outCust),
  };
}

function buildStageData(
  starts: Float64Array,
  ends: Float64Array,
  cust: Uint32Array,
  customerCount: number
): StageData {
  // Group by customer, compress to Pareto frontier.
  const byCust = countingSortIndices(cust, cust.length, customerCount);
  const gStarts = new Float64Array(cust.length);
  const gEnds = new Float64Array(cust.length);
  const gCust = new Uint32Array(cust.length);
  for (let i = 0; i < byCust.length; i++) {
    gStarts[i] = starts[byCust[i]];
    gEnds[i] = ends[byCust[i]];
    gCust[i] = cust[byCust[i]];
  }
  const frontier = frontierFilter(gStarts, gEnds, gCust, customerCount);
  const n = frontier.starts.length;
  // Main copy sorted by start time.
  let order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order = radixSortIndicesByF64(frontier.starts, order);
  const sStarts = new Float64Array(n);
  const sEnds = new Float64Array(n);
  const sCust = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    sStarts[i] = frontier.starts[order[i]];
    sEnds[i] = frontier.ends[order[i]];
    sCust[i] = frontier.cust[order[i]];
  }
  // Second copy sorted by end time.
  let order2 = new Uint32Array(n);
  for (let i = 0; i < n; i++) order2[i] = i;
  order2 = radixSortIndicesByF64(frontier.ends, order2);
  const eEnds = new Float64Array(n);
  const eStarts = new Float64Array(n);
  const eCust = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    eEnds[i] = frontier.ends[order2[i]];
    eStarts[i] = frontier.starts[order2[i]];
    eCust[i] = frontier.cust[order2[i]];
  }
  return {
    n,
    starts: sStarts,
    ends: sEnds,
    cust: sCust,
    endsSorted: eEnds,
    startsByEnd: eStarts,
    custByEnd: eCust,
  };
}

/** Build the prepared (immutable) query structure from raw events. */
export function buildPrepared(input: EventInput): PreparedData {
  const events = normalizeEvents(input);
  const n = events.count;
  const time = events.time as Float64Array;
  const seq = events.seq;
  const journey = events.journey;
  const customer = events.customer;
  const action = events.action;

  // Sort indices by (journey, time, seq): stable sorts applied in reverse key order.
  let maxSeq = 0;
  for (let i = 0; i < n; i++) if (seq[i] > maxSeq) maxSeq = seq[i];
  let order = countingSortIndices(seq, n, maxSeq + 1);
  order = radixSortIndicesByF64(time, order);
  order = countingSortIndicesInPlace(journey, order, events.journeyCount);

  // Per-journey greedy chains. For each impression event, the earliest
  // completion of each stage; points are (chainStart, stageEnd, customer).
  const sinks: PointSink[] = [];
  for (let k = 0; k < STAGE_COUNT; k++) sinks.push(new PointSink());

  const jTime = new Float64Array(64);
  const jAction = new Uint8Array(64);
  const jNextClick = new Int32Array(64);
  const jNextConv = new Int32Array(64);
  let jCust = 0;
  let jLen = 0;
  let scratchTime = jTime;
  let scratchAction = jAction;
  let scratchNextClick = jNextClick;
  let scratchNextConv = jNextConv;

  const flushJourney = (): void => {
    const m = jLen;
    if (m === 0) return;
    // nextClick[i] / nextConv[i]: smallest index > i with that action, or -1.
    let nextClick = -1;
    let nextConv = -1;
    for (let i = m - 1; i >= 0; i--) {
      scratchNextClick[i] = nextClick;
      scratchNextConv[i] = nextConv;
      const a = scratchAction[i];
      if (a === ACTION_CLICK) nextClick = i;
      else if (a === ACTION_CONVERSION) nextConv = i;
    }
    for (let i = 0; i < m; i++) {
      if (scratchAction[i] !== ACTION_IMPRESSION) continue;
      const t0 = scratchTime[i];
      sinks[0].push(t0, t0, jCust);
      const i1 = scratchNextClick[i];
      if (i1 < 0) continue;
      const t1 = scratchTime[i1];
      sinks[1].push(t0, t1, jCust);
      const i2 = scratchNextClick[i1];
      if (i2 < 0) continue;
      const t2 = scratchTime[i2];
      sinks[2].push(t0, t2, jCust);
      const i3 = scratchNextConv[i2];
      if (i3 < 0) continue;
      const t3 = scratchTime[i3];
      sinks[3].push(t0, t3, jCust);
    }
  };

  let prevJourney = -1;
  for (let p = 0; p < n; p++) {
    const idx = order[p];
    const j = journey[idx];
    if (j !== prevJourney) {
      flushJourney();
      jLen = 0;
      prevJourney = j;
      jCust = customer[idx];
    }
    if (jLen === scratchTime.length) {
      const cap = jLen * 2;
      const nt = new Float64Array(cap);
      nt.set(scratchTime);
      scratchTime = nt;
      const na = new Uint8Array(cap);
      na.set(scratchAction);
      scratchAction = na;
      const nc = new Int32Array(cap);
      scratchNextClick = nc;
      const nv = new Int32Array(cap);
      scratchNextConv = nv;
    }
    scratchTime[jLen] = time[idx];
    scratchAction[jLen] = action[idx];
    jLen++;
  }
  flushJourney();

  const stages: StageData[] = [];
  for (let k = 0; k < STAGE_COUNT; k++) {
    const sink = sinks[k];
    stages.push(
      buildStageData(
        Float64Array.from(sink.starts),
        Float64Array.from(sink.ends),
        Uint32Array.from(sink.custs),
        events.customerCount
      )
    );
  }

  return {
    version: PREPARED_VERSION,
    customerCount: events.customerCount,
    journeyCount: events.journeyCount,
    eventCount: n,
    stages,
  };
}
