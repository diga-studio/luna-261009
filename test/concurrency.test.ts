import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPath } from "../src/index.js";
import type { ModuleSpec, ProgressSnapshot, ScoreSubmission } from "../src/index.js";

/** 与实现无关的参考模型：按操作日志逐步重算期望状态。 */
class ReferenceModel {
  private revisions: Array<{ modules: ModuleSpec[]; passPercent: number }> = [];
  private scores = new Map<string, ScoreSubmission>();
  private badges = new Set<string>();

  publish(modules: ModuleSpec[], passPercent: number): void {
    this.revisions.push({ modules, passPercent });
    this.settleAll();
  }

  submit(score: ScoreSubmission): void {
    if (this.scores.has(score.attemptId)) return;
    this.scores.set(score.attemptId, score);
    this.settle(score.learnerId);
  }

  progress(learnerId: string): ProgressSnapshot {
    const rev = this.revisions[this.revisions.length - 1];
    assert.ok(rev, "reference model requires at least one revision");
    const revisionId = this.revisions.length;
    const modules = rev.modules.map((mod) => ({
      moduleId: mod.moduleId,
      contentVersion: mod.contentVersion,
      passed: this.isPassed(learnerId, mod, rev.passPercent),
    }));
    return {
      revisionId,
      passPercent: rev.passPercent,
      modules,
      allPassed: modules.every((m) => m.passed),
      currentBadgeEarned: this.badges.has(`${learnerId}|${revisionId}`),
    };
  }

  badgeIds(learnerId: string): number[] {
    const ids: number[] = [];
    for (const key of this.badges) {
      const [learner, rev] = key.split("|");
      if (learner === learnerId) ids.push(Number(rev));
    }
    return ids.sort((a, b) => a - b);
  }

  private isPassed(learnerId: string, mod: ModuleSpec, passPercent: number): boolean {
    for (const s of this.scores.values()) {
      if (
        s.learnerId === learnerId &&
        s.moduleId === mod.moduleId &&
        s.contentVersion === mod.contentVersion &&
        s.correct * 100 >= s.total * passPercent
      ) {
        return true;
      }
    }
    return false;
  }

  private settle(learnerId: string): void {
    if (this.revisions.length === 0) return;
    const rev = this.revisions[this.revisions.length - 1]!;
    const allPassed = rev.modules.every((mod) => this.isPassed(learnerId, mod, rev.passPercent));
    if (allPassed) this.badges.add(`${learnerId}|${this.revisions.length}`);
  }

  private settleAll(): void {
    const learners = new Set([...this.scores.values()].map((s) => s.learnerId));
    for (const learner of learners) this.settle(learner);
  }
}

type LogEntry =
  | { op: "publish"; modules: ModuleSpec[]; passPercent: number }
  | { op: "submit"; score: ScoreSubmission }
  | { op: "getProgress"; learnerId: string; result: ProgressSnapshot }
  | { op: "getBadges"; learnerId: string; result: number[] };

test("并发发布、接收与读取：每次读取都与按操作顺序独立重算的结果一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-conc-"));
  const lp = new LearningPath(join(dir, "test.db"));
  const log: LogEntry[] = [];

  // 包装真实调用，记录实际执行顺序与结果。
  const publish = (modules: ModuleSpec[], passPercent: number) => {
    lp.publishRevision(modules, passPercent);
    log.push({ op: "publish", modules, passPercent });
  };
  const submit = (score: ScoreSubmission) => {
    lp.submitScore(score);
    log.push({ op: "submit", score });
  };
  const getProgress = (learnerId: string) => {
    const result = lp.getProgress(learnerId);
    log.push({ op: "getProgress", learnerId, result });
  };
  const getBadges = (learnerId: string) => {
    const result = lp.getBadges(learnerId).map((b) => b.revisionId);
    log.push({ op: "getBadges", learnerId, result });
  };

  const learners = ["w1", "w2", "w3", "w4", "w5"];
  const moduleIds = ["safety", "welding", "assembly"];
  const versions = ["v1", "v2", "v3"];
  let attempt = 0;
  let revisionCount = 0;
  publish(
    moduleIds.map((moduleId) => ({ moduleId, contentVersion: "v1" })),
    60,
  );
  revisionCount += 1;

  const random = mulberry32(42);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

  const worker = async (kind: "publisher" | "submitter" | "reader", n: number) => {
    for (let i = 0; i < n; i++) {
      if (kind === "publisher") {
        const modules = moduleIds
          .filter(() => random() < 0.8)
          .map((moduleId) => ({ moduleId, contentVersion: pick(versions) }));
        if (modules.length === 0) modules.push({ moduleId: "safety", contentVersion: pick(versions) });
        publish(modules, 1 + Math.floor(random() * 100));
        revisionCount += 1;
      } else if (kind === "submitter") {
        attempt += 1;
        const total = 1 + Math.floor(random() * 20);
        submit({
          learnerId: pick(learners),
          // 偶尔重复提交旧答题编号。
          attemptId: random() < 0.2 ? `a-${Math.max(1, attempt - 3)}` : `a-${attempt}`,
          moduleId: pick(moduleIds),
          contentVersion: pick(versions),
          correct: Math.floor(random() * (total + 1)),
          total,
        });
      } else {
        const learnerId = pick(learners);
        if (random() < 0.5) getProgress(learnerId);
        else getBadges(learnerId);
      }
      // 让出事件循环，制造交错。
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  await Promise.all([
    worker("publisher", 15),
    worker("submitter", 120),
    worker("submitter", 120),
    worker("reader", 80),
    worker("reader", 80),
  ]);

  // 按实际执行顺序在参考模型上重放，逐条比对读取结果。
  const model = new ReferenceModel();
  let checkedReads = 0;
  for (const entry of log) {
    if (entry.op === "publish") {
      model.publish(entry.modules, entry.passPercent);
    } else if (entry.op === "submit") {
      model.submit(entry.score);
    } else if (entry.op === "getProgress") {
      assert.deepEqual(entry.result, model.progress(entry.learnerId));
      // 快照内部一致性：不能出现全部达标却未授予当前徽章的撕裂状态。
      if (entry.result.allPassed) {
        assert.equal(entry.result.currentBadgeEarned, true);
      }
      checkedReads += 1;
    } else {
      assert.deepEqual(entry.result, model.badgeIds(entry.learnerId));
      checkedReads += 1;
    }
  }
  assert.ok(checkedReads > 100, `expected many checked reads, got ${checkedReads}`);
  assert.ok(revisionCount > 10);
  lp.close();
});

test("同一数据库文件的两个实例交错写入，状态保持一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-conc-"));
  const dbFile = join(dir, "test.db");
  const a = new LearningPath(dbFile);
  const b = new LearningPath(dbFile);

  a.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  b.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 60);
  a.submitScore({ learnerId: "w1", attemptId: "x1", moduleId: "safety", contentVersion: "v1", correct: 11, total: 20 });
  b.submitScore({ learnerId: "w1", attemptId: "x2", moduleId: "safety", contentVersion: "v1", correct: 13, total: 20 });

  // 两个实例看到一致的当前修订与徽章状态。
  const pa = a.getProgress("w1");
  const pb = b.getProgress("w1");
  assert.deepEqual(pa, pb);
  assert.equal(pa.revisionId, 2);
  assert.equal(pa.allPassed, true);
  assert.equal(pa.currentBadgeEarned, true);
  assert.deepEqual(a.getBadges("w1").map((x) => x.revisionId), [2]);
  a.close();
  b.close();
});

/** 确定性伪随机数，保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
