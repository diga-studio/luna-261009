import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { openFunnel, prepareFunnel } from "../src/index";
import { readRawEventsFile, writeRawEventsFile } from "../src/rawfile";
import {
  ACTION_CLICK,
  ACTION_CONVERSION,
  ACTION_IMPRESSION,
  ColumnarEvents,
  STAGE_COUNT,
  StageCounts,
} from "../src/types";
import { countingSortIndicesInPlace, radixSortIndicesByF64 } from "../src/sort";
import { BenchScale, FULL_SCALE, generateEvents, generateQueries } from "./gen";
import { RunnerStats } from "./query-runner";

const SMOKE_SCALE: BenchScale = {
  events: 500_000,
  customers: 30_000,
  journeys: 120_000,
  queries: 2_000,
};

function scaleFromEnv(): BenchScale {
  return process.env.BENCH_SCALE === "smoke" ? SMOKE_SCALE : FULL_SCALE;
}

/** Independent full computation: single pass over journey-sorted events. */
function fullComputation(
  events: ColumnarEvents,
  order: Uint32Array,
  S: number,
  E: number
): StageCounts {
  const n = events.count;
  const time = events.time as Float64Array;
  const action = events.action;
  const journey = events.journey;
  const customer = events.customer;
  const maxStage = new Uint8Array(events.customerCount);
  const touched: number[] = [];
  let curJourney = -1;
  let curStage = 0;
  let curCustomer = -1;
  const flush = (): void => {
    if (curJourney < 0 || curStage === 0) return;
    if (maxStage[curCustomer] === 0) touched.push(curCustomer);
    if (curStage > maxStage[curCustomer]) maxStage[curCustomer] = curStage;
  };
  for (let p = 0; p < n; p++) {
    const idx = order[p];
    const j = journey[idx];
    if (j !== curJourney) {
      flush();
      curJourney = j;
      curStage = 0;
      curCustomer = customer[idx];
    }
    const t = time[idx];
    if (t < S || t >= E) continue;
    const a = action[idx];
    if (curStage === 0 && a === ACTION_IMPRESSION) curStage = 1;
    else if (curStage === 1 && a === ACTION_CLICK) curStage = 2;
    else if (curStage === 2 && a === ACTION_CLICK) curStage = 3;
    else if (curStage === 3 && a === ACTION_CONVERSION) curStage = 4;
  }
  flush();
  const counts: StageCounts = [0, 0, 0, 0];
  for (const c of touched) {
    for (let k = 0; k < maxStage[c]; k++) counts[k]++;
    maxStage[c] = 0;
  }
  return counts;
}

function fmt(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function run(): boolean {
  const scale = scaleFromEnv();
  const workDir = path.join(__dirname, "..", "..", ".bench");
  fs.mkdirSync(workDir, { recursive: true });
  const rawFile = path.join(workDir, `events-${scale.events}.bin`);
  const preparedDir = path.join(workDir, `prepared-${scale.events}`);
  const workloadFile = path.join(workDir, `workload-${scale.events}.json`);
  const resultsFile = path.join(workDir, `results-${scale.events}.json`);
  const statsFile = path.join(workDir, `stats-${scale.events}.json`);

  console.log(`=== journey-funnel benchmark (scale: ${JSON.stringify(scale)}) ===`);

  // 1. Generate (or reuse) raw events, persisted to a local file.
  let events: ColumnarEvents;
  if (fs.existsSync(rawFile)) {
    console.log(`raw events: reusing ${rawFile}`);
    events = readRawEventsFile(rawFile);
  } else {
    const t0 = Date.now();
    events = generateEvents(scale);
    writeRawEventsFile(rawFile, events);
    console.log(`raw events: generated + saved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 2. Prepare + persist (preparation time is not part of query budget).
  const tPrep = Date.now();
  prepareFunnel(events, preparedDir);
  console.log(`prepare+save: ${((Date.now() - tPrep) / 1000).toFixed(1)}s`);

  // 3. Query workload.
  const sortedTimes = Float64Array.from(events.time as Float64Array).sort();
  const workload = generateQueries(scale, sortedTimes);
  fs.writeFileSync(workloadFile, JSON.stringify(workload));

  // 4. Fresh-process reopen: warmup + timed queries (the measured process).
  execFileSync(process.execPath, [
    path.join(__dirname, "query-runner.js"),
    preparedDir,
    workloadFile,
    resultsFile,
    statsFile,
  ]);
  const stats = JSON.parse(fs.readFileSync(statsFile, "utf8")) as RunnerStats;
  const childResults = JSON.parse(fs.readFileSync(resultsFile, "utf8")) as StageCounts[];

  // 5. Reopen consistency: this process computes the same queries from the
  //    same prepared files; all stage counts must match the child process.
  const db = openFunnel(preparedDir);
  let mismatches = 0;
  for (let i = 0; i < workload.timed.length; i++) {
    const [s, e] = workload.timed[i];
    const got = db.query(s, e);
    const want = childResults[i];
    if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2] || got[3] !== want[3]) {
      mismatches++;
    }
  }
  console.log(`reopen consistency: ${mismatches === 0 ? "PASS" : `FAIL (${mismatches})`}`);

  // 6. Sampled verification against the independent full computation.
  let maxSeq = 0;
  const seqArr = events.seq;
  for (let i = 0; i < events.count; i++) if (seqArr[i] > maxSeq) maxSeq = seqArr[i];
  const identity = new Uint32Array(events.count);
  for (let i = 0; i < events.count; i++) identity[i] = i;
  let order = countingSortIndicesInPlace(seqArr, identity, maxSeq + 1);
  order = radixSortIndicesByF64(events.time as Float64Array, order);
  order = countingSortIndicesInPlace(events.journey, order, events.journeyCount);
  const sampleCount = Math.min(25, workload.timed.length);
  let sampleFails = 0;
  for (let sIdx = 0; sIdx < sampleCount; sIdx++) {
    const qi = Math.floor((sIdx * workload.timed.length) / sampleCount);
    const [S, E] = workload.timed[qi];
    const want = fullComputation(events, order, S, E);
    const got = childResults[qi];
    if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2] || got[3] !== want[3]) {
      sampleFails++;
      console.log(`  sample ${qi} [${S}, ${E}): got ${got} want ${want}`);
    }
  }
  console.log(
    `sampled full-computation check (${sampleCount} queries): ${sampleFails === 0 ? "PASS" : `FAIL (${sampleFails})`}`
  );

  // 7. Workload shape checks.
  const n = events.count;
  let wide = 0;
  const distinctPerStage: Set<number>[] = [];
  for (let k = 0; k < STAGE_COUNT; k++) distinctPerStage.push(new Set());
  for (let i = 0; i < workload.timed.length; i++) {
    const [S, E] = workload.timed[i];
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedTimes[mid] < S) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;
    lo = 0;
    hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedTimes[mid] < E) lo = mid + 1;
      else hi = mid;
    }
    const frac = (lo - first) / n;
    if (frac >= 0.5 && frac <= 0.9) wide++;
    for (let k = 0; k < STAGE_COUNT; k++) distinctPerStage[k].add(childResults[i][k]);
  }
  const widePct = ((100 * wide) / workload.timed.length).toFixed(1);
  console.log(`windows covering 50-90% of events: ${widePct}% (requirement: >=80%)`);
  console.log(
    `distinct stage counts across queries: [${distinctPerStage.map((s) => s.size).join(", ")}]`
  );

  // 8. Performance report.
  console.log(`--- query performance (fresh process, after ${workload.warmup.length} warmup) ---`);
  console.log(`queries:        ${stats.queryCount}`);
  console.log(`total time:     ${(stats.totalMs / 1000).toFixed(2)}s (target <= 8s)`);
  console.log(`p50 / p95 / p99: ${stats.p50Ms.toFixed(3)} / ${stats.p95Ms.toFixed(3)} / ${stats.p99Ms.toFixed(3)} ms (p95 target <= 2ms)`);
  console.log(`max:            ${stats.maxMs.toFixed(3)} ms`);
  console.log(`RSS after load: ${fmt(stats.rssAfterLoadBytes)}`);
  console.log(`peak RSS:       ${fmt(stats.peakRssBytes)} (target <= 768 MiB)`);

  const pass =
    mismatches === 0 &&
    sampleFails === 0 &&
    wide / workload.timed.length >= 0.8 &&
    stats.totalMs <= 8000 &&
    stats.p95Ms <= 2 &&
    stats.peakRssBytes <= 768 * 1024 * 1024;
  console.log(`overall: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
  return pass;
}

if (require.main === module) {
  run();
}
