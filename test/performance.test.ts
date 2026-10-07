import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LearningPath } from "../src/index.js";
import type { ModuleSpec } from "../src/index.js";

const LEARNERS = 500;
const MODULES = 30;
const SCORES = 100_000;

function buildModules(): ModuleSpec[] {
  return Array.from({ length: MODULES }, (_, i) => ({
    moduleId: `module-${i}`,
    contentVersion: "v1",
  }));
}

test("性能：300 次进度查询 p95 ≤ 100ms，一次修订发布 ≤ 2s", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-perf-"));
  const dbFile = join(dir, "perf.db");
  const lp = new LearningPath(dbFile);
  lp.publishRevision(buildModules(), 60);

  // 直接用 SQL 批量构造 10 万条成绩作为测试基线数据。
  const db = new DatabaseSync(dbFile);
  db.exec("BEGIN");
  const insert = db.prepare(
    `INSERT INTO scores (attempt_id, learner_id, module_id, content_version, correct, total, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (let i = 0; i < SCORES; i++) {
    const total = 10 + (i % 11);
    insert.run(
      `bulk-${i}`,
      `learner-${i % LEARNERS}`,
      `module-${i % MODULES}`,
      "v1",
      i % (total + 1),
      total,
      now,
    );
  }
  db.exec("COMMIT");
  db.close();

  // 测量一次修订发布（含 500 名学习者的重新结算）。
  const publishStart = performance.now();
  lp.publishRevision(buildModules(), 70);
  const publishMs = performance.now() - publishStart;
  assert.ok(publishMs < 2000, `publish took ${publishMs.toFixed(1)}ms, expected < 2000ms`);

  // 测量连续 300 次当前进度查询的 p95。
  const samples: number[] = [];
  for (let i = 0; i < 300; i++) {
    const start = performance.now();
    lp.getProgress(`learner-${i % LEARNERS}`);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  assert.ok(p95 < 100, `getProgress p95 was ${p95.toFixed(2)}ms, expected < 100ms`);

  console.log(
    `  perf: publish=${publishMs.toFixed(1)}ms, getProgress p95=${p95.toFixed(2)}ms (scores=${SCORES}, learners=${LEARNERS})`,
  );
  lp.close();
});
