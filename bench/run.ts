import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { prepare, save } from "../src/index";
import { genEvents, BENCH } from "./gen";
import { verifySamples, compareResults, checkVariation } from "./verify";

/**
 * 基准流程：
 * 1. 生成 1000 万事件并准备数据（计时，不计入查询耗时）；
 * 2. 保存准备结果；
 * 3. 新进程 A 打开数据，预热 100 次后串行执行 10000 次查询；
 * 4. 新进程 B 重开同一份数据执行相同查询，结果逐条一致；
 * 5. 抽样与全量暴力计算比对，检查宽窗口计数变化。
 */
function main(): void {
  const dir = path.resolve(".bench-data");
  fs.mkdirSync(dir, { recursive: true });
  const dataFile = path.join(dir, "funnel.jf");

  console.log(`[prepare] generating ${BENCH.eventTarget} events ...`);
  const t0 = Date.now();
  const prepared = prepare(genEvents());
  const prepareMs = Date.now() - t0;
  console.log(`[prepare] done in ${(prepareMs / 1000).toFixed(1)}s`);

  save(prepared, dataFile);
  const fileMiB = fs.statSync(dataFile).size / 1048576;
  console.log(`[save] ${dataFile} (${fileMiB.toFixed(1)} MiB)`);

  const childScript = path.join(__dirname, "child_query.js");
  for (const label of ["A", "B"]) {
    console.log(`[query ${label}] reopening in a fresh process ...`);
    const out = execFileSync(
      process.execPath,
      [
        childScript,
        dataFile,
        path.join(dir, `results${label}.bin`),
        path.join(dir, `report${label}.json`),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    console.log(`[query ${label}] ${out.trim()}`);
  }

  compareResults(
    path.join(dir, "resultsA.bin"),
    path.join(dir, "resultsB.bin"),
  );
  verifySamples(path.join(dir, "resultsA.bin"), 30);
  checkVariation(path.join(dir, "resultsA.bin"));

  const reportA = JSON.parse(
    fs.readFileSync(path.join(dir, "reportA.json"), "utf8"),
  );
  const reportB = JSON.parse(
    fs.readFileSync(path.join(dir, "reportB.json"), "utf8"),
  );
  console.log("\n==== benchmark report ====");
  console.log(`events: ${BENCH.eventTarget}, customers: ${BENCH.customerCount}, journeys: ${BENCH.journeyCount}`);
  console.log(`prepare: ${(prepareMs / 1000).toFixed(1)}s (not counted in query time)`);
  console.log(`data file: ${fileMiB.toFixed(1)} MiB`);
  for (const [label, r] of [["A", reportA], ["B", reportB]] as const) {
    console.log(
      `process ${label}: total=${r.totalMs}ms p50=${r.p50Ms}ms p95=${r.p95Ms}ms max=${r.maxMs}ms peakRSS=${r.peakRssMiB}MiB`,
    );
  }
  const ok =
    reportA.totalMs <= 8000 &&
    reportA.p95Ms <= 2 &&
    reportA.peakRssMiB <= 768 &&
    reportB.totalMs <= 8000 &&
    reportB.p95Ms <= 2 &&
    reportB.peakRssMiB <= 768;
  console.log(ok ? "PASS: all targets met" : "FAIL: target missed");
  if (!ok) process.exitCode = 1;
}

main();
