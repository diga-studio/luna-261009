import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPathService, ModuleSpec } from "../src/index";

test("性能：300 次进度查询 p95 < 100ms，一次修订发布 < 2s", () => {
  const dir = mkdtempSync(join(tmpdir(), "lps-perf-"));
  const svc = new LearningPathService(join(dir, "perf.db"));
  try {
    const learnerCount = 500;
    const learners = Array.from({ length: learnerCount }, (_, i) => `w${i}`);
    svc.setLearners(learners);

    const modules: ModuleSpec[] = Array.from({ length: 30 }, (_, i) => ({
      moduleId: `m${i}`,
      contentVersion: "v1",
    }));
    svc.publishRevision({ modules, passPercent: 70 });

    // 每个学习者提交约 10 条成绩（共 5000 条），部分达标部分不达标。
    let seq = 0;
    for (const learnerId of learners) {
      for (let k = 0; k < 10; k++) {
        seq += 1;
        svc.submitAttempt({
          attemptId: `p-${seq}`,
          learnerId,
          moduleId: `m${k}`,
          contentVersion: "v1",
          correct: k % 2 === 0 ? 8 : 5,
          total: 10,
        });
      }
    }

    // 连续 300 次当前进度查询。
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const start = Date.now();
      svc.getProgress(learners[i % learnerCount]!);
      samples.push(Date.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
    assert.ok(p95 <= 100, `300 次查询 p95 应 ≤100ms，实际 ${p95}ms`);

    // 一次修订发布（500 名学习者全部重新结算）。
    const start = Date.now();
    svc.publishRevision({ modules, passPercent: 60 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed <= 2000, `修订发布应 ≤2000ms，实际 ${elapsed}ms`);
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
