import * as fs from "fs";
import { open } from "../src/index";
import { genWindows } from "./windows";

/**
 * 查询子进程：node child_query.js <数据文件> <结果输出文件> <报告输出文件>
 * 打开准备数据 -> 100 次预热 -> 10000 次串行查询，记录每次耗时与峰值 RSS。
 */
function main(): void {
  const [, , dataFile, resultsFile, reportFile] = process.argv;
  const analyzer = open(dataFile);
  const { warmup, queries } = genWindows();

  for (const w of warmup) analyzer.query(w.start, w.end);

  const times = new Float64Array(queries.length);
  const results = new Uint32Array(queries.length * 4);
  let peakRss = process.memoryUsage().rss;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < queries.length; i++) {
    const w = queries[i];
    const s = process.hrtime.bigint();
    const r = analyzer.query(w.start, w.end);
    const elapsed = process.hrtime.bigint() - s;
    times[i] = Number(elapsed) / 1e6;
    results[i * 4] = r[0];
    results[i * 4 + 1] = r[1];
    results[i * 4 + 2] = r[2];
    results[i * 4 + 3] = r[3];
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const sorted = Float64Array.from(times).sort();
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const max = sorted[sorted.length - 1];

  fs.writeFileSync(resultsFile, Buffer.from(results.buffer));
  fs.writeFileSync(
    reportFile,
    JSON.stringify(
      {
        queryCount: queries.length,
        totalMs: Math.round(totalMs * 100) / 100,
        p50Ms: Math.round(p50 * 1000) / 1000,
        p95Ms: Math.round(p95 * 1000) / 1000,
        maxMs: Math.round(max * 1000) / 1000,
        peakRssMiB: Math.round((peakRss / 1048576) * 10) / 10,
      },
      null,
      2,
    ),
  );
  console.log(
    `queries=${queries.length} total=${totalMs.toFixed(0)}ms p95=${p95.toFixed(3)}ms peakRSS=${(peakRss / 1048576).toFixed(1)}MiB`,
  );
}

main();
