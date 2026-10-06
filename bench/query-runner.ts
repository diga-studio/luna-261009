import * as fs from "fs";
import { openFunnel } from "../src/index";
import { StageCounts } from "../src/types";

export interface RunnerStats {
  queryCount: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  peakRssBytes: number;
  rssAfterLoadBytes: number;
}

/**
 * Child-process query runner: opens a prepared directory (no state from the
 * preparing process), runs warmup + timed queries, measures latency and RSS,
 * and writes per-query results plus stats as JSON.
 * Usage: node query-runner.js <preparedDir> <workload.json> <results.json> <stats.json>
 */
export function main(argv: string[]): void {
  const [dir, workloadFile, resultsFile, statsFile] = argv;
  const workload = JSON.parse(fs.readFileSync(workloadFile, "utf8")) as {
    warmup: [number, number][];
    timed: [number, number][];
  };
  const db = openFunnel(dir);
  const rssAfterLoad = process.memoryUsage().rss;

  for (const [s, e] of workload.warmup) {
    db.query(s, e);
  }

  const latencies = new Float64Array(workload.timed.length);
  const results: StageCounts[] = new Array(workload.timed.length);
  let peakRss = process.memoryUsage().rss;
  for (let i = 0; i < workload.timed.length; i++) {
    const [s, e] = workload.timed[i];
    const t0 = process.hrtime.bigint();
    results[i] = db.query(s, e);
    const t1 = process.hrtime.bigint();
    latencies[i] = Number(t1 - t0) / 1e6;
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }
  db.close();

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const stats: RunnerStats = {
    queryCount: workload.timed.length,
    totalMs: latencies.reduce((a, b) => a + b, 0),
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    p99Ms: q(0.99),
    maxMs: sorted[sorted.length - 1],
    peakRssBytes: peakRss,
    rssAfterLoadBytes: rssAfterLoad,
  };
  fs.writeFileSync(resultsFile, JSON.stringify(results));
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2));
}
