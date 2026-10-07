import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPath } from "../src/index.js";
import type { ScoreSubmission } from "../src/index.js";

function freshPath(): { lp: LearningPath; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lp-test-"));
  const lp = new LearningPath(join(dir, "test.db"));
  return { lp, close: () => lp.close() };
}

let attemptCounter = 0;
function score(partial: Omit<ScoreSubmission, "attemptId"> & { attemptId?: string }): ScoreSubmission {
  attemptCounter += 1;
  return { attemptId: `attempt-${attemptCounter}`, ...partial };
}

test("提高阈值后既有成绩可能不再达标，历史徽章保留", () => {
  const { lp, close } = freshPath();
  lp.publishRevision(
    [
      { moduleId: "safety", contentVersion: "v1" },
      { moduleId: "welding", contentVersion: "v1" },
    ],
    50,
  );
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 5, total: 10 }));
  lp.submitScore(score({ learnerId: "w1", moduleId: "welding", contentVersion: "v1", correct: 6, total: 10 }));

  const before = lp.getProgress("w1");
  assert.equal(before.allPassed, true);
  assert.equal(before.currentBadgeEarned, true);
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [1]);

  // 提高阈值到 70%：safety 的 50% 不再达标，当前进度回退。
  lp.publishRevision(
    [
      { moduleId: "safety", contentVersion: "v1" },
      { moduleId: "welding", contentVersion: "v1" },
    ],
    70,
  );
  const after = lp.getProgress("w1");
  assert.equal(after.revisionId, 2);
  assert.equal(after.allPassed, false);
  assert.equal(after.currentBadgeEarned, false);
  assert.deepEqual(
    after.modules.map((m) => [m.moduleId, m.passed]),
    [
      ["safety", false],
      ["welding", false],
    ],
  );
  // 历史徽章永久保留，但不代表当前修订已完成。
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [1]);
  close();
});

test("降低阈值后既有成绩立即达标并授予当前修订徽章", () => {
  const { lp, close } = freshPath();
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 80);
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 6, total: 10 }));
  assert.equal(lp.getProgress("w1").allPassed, false);

  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 60);
  const progress = lp.getProgress("w1");
  assert.equal(progress.allPassed, true);
  assert.equal(progress.currentBadgeEarned, true);
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [2]);
  close();
});

test("模块移除后重新加入：同身份同版本的历史成绩可复用", () => {
  const { lp, close } = freshPath();
  lp.publishRevision(
    [
      { moduleId: "safety", contentVersion: "v1" },
      { moduleId: "welding", contentVersion: "v1" },
    ],
    50,
  );
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 8, total: 10 }));
  lp.submitScore(score({ learnerId: "w1", moduleId: "welding", contentVersion: "v1", correct: 8, total: 10 }));
  assert.equal(lp.getProgress("w1").allPassed, true);

  // 修订 2 移除 welding。
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  const removed = lp.getProgress("w1");
  assert.equal(removed.revisionId, 2);
  assert.deepEqual(removed.modules.map((m) => m.moduleId), ["safety"]);
  assert.equal(removed.allPassed, true);

  // 修订 3 以原身份原版本重新加入 welding：历史成绩再次生效。
  lp.publishRevision(
    [
      { moduleId: "safety", contentVersion: "v1" },
      { moduleId: "welding", contentVersion: "v1" },
    ],
    50,
  );
  const rejoined = lp.getProgress("w1");
  assert.equal(rejoined.allPassed, true);
  assert.equal(rejoined.currentBadgeEarned, true);
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [1, 2, 3]);
  close();
});

test("内容版本切换后收到旧成绩：保留但不贡献进度，重新采用旧版本时可复用", () => {
  const { lp, close } = freshPath();
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v2" }], 50);

  // 晚到的旧内容成绩：与当前版本不匹配，不贡献进度。
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 10, total: 10 }));
  const stale = lp.getProgress("w1");
  assert.equal(stale.allPassed, false);
  assert.equal(stale.currentBadgeEarned, false);

  // 重新采用 v1：旧成绩立即生效。
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  const reused = lp.getProgress("w1");
  assert.equal(reused.allPassed, true);
  assert.equal(reused.currentBadgeEarned, true);
  // 修订 1 从未完成，不补发其徽章。
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [2]);
  close();
});

test("相同版本标识不能跨模块身份复用", () => {
  const { lp, close } = freshPath();
  lp.publishRevision(
    [
      { moduleId: "safety", contentVersion: "v1" },
      { moduleId: "welding", contentVersion: "v1" },
    ],
    50,
  );
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 10, total: 10 }));
  const progress = lp.getProgress("w1");
  assert.deepEqual(
    progress.modules.map((m) => [m.moduleId, m.passed]),
    [
      ["safety", true],
      ["welding", false],
    ],
  );
  close();
});

test("失败重考不覆盖已有达标证据，重复提交只计一次且不重复授徽章", () => {
  const { lp, close } = freshPath();
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  const passing = score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 9, total: 10 });
  assert.deepEqual(lp.submitScore(passing), { accepted: true });
  assert.equal(lp.getProgress("w1").allPassed, true);

  // 失败重考：已有达标成绩仍然有效。
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 1, total: 10 }));
  assert.equal(lp.getProgress("w1").allPassed, true);
  assert.equal(lp.getProgress("w1").currentBadgeEarned, true);

  // 重复提交同一答题编号：不计入第二次。
  assert.deepEqual(lp.submitScore(passing), { accepted: false });
  assert.equal(lp.getProgress("w1").allPassed, true);
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [1]);
  close();
});

test("按精确比例判断：四舍五入后看似通过的成绩仍判未达标", () => {
  const { lp, close } = freshPath();
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 67);
  // 2/3 ≈ 66.67%，四舍五入展示为 67%，但精确比例未达 67%。
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 2, total: 3 }));
  assert.equal(lp.getProgress("w1").allPassed, false);
  assert.equal(lp.getProgress("w1").currentBadgeEarned, false);

  // 201/300 = 67%，精确达标。
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 201, total: 300 }));
  assert.equal(lp.getProgress("w1").allPassed, true);
  close();
});

test("晚到成绩只参与接收时当前修订的结算，不补发已下线修订的徽章", () => {
  const { lp, close } = freshPath();
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  // 修订 2 换成新内容，修订 1 下线。
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v2" }], 50);
  // 晚到的 v1 满分成绩：不匹配当前修订，不补发修订 1 的徽章。
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 10, total: 10 }));
  assert.equal(lp.getProgress("w1").allPassed, false);
  assert.deepEqual(lp.getBadges("w1"), []);
  close();
});

test("发布时未提交新成绩的学习者也按新标准重新结算", () => {
  const { lp, close } = freshPath();
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 8, total: 10 }));
  assert.equal(lp.getProgress("w1").currentBadgeEarned, true);

  // 没有新成绩，仅提高阈值：徽章不迁移，当前进度回退。
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 90);
  const progress = lp.getProgress("w1");
  assert.equal(progress.allPassed, false);
  assert.equal(progress.currentBadgeEarned, false);
  assert.deepEqual(lp.getBadges("w1").map((b) => b.revisionId), [1]);
  close();
});

test("输入校验：非法修订与成绩被拒绝", () => {
  const { lp, close } = freshPath();
  assert.throws(() => lp.publishRevision([], 50), RangeError);
  assert.throws(
    () => lp.publishRevision(Array.from({ length: 31 }, (_, i) => ({ moduleId: `m${i}`, contentVersion: "v1" })), 50),
    RangeError,
  );
  assert.throws(() => lp.publishRevision([{ moduleId: "m", contentVersion: "v" }], 0), RangeError);
  assert.throws(() => lp.publishRevision([{ moduleId: "m", contentVersion: "v" }], 101), RangeError);
  assert.throws(
    () =>
      lp.publishRevision(
        [
          { moduleId: "m", contentVersion: "v1" },
          { moduleId: "m", contentVersion: "v2" },
        ],
        50,
      ),
    RangeError,
  );
  lp.publishRevision([{ moduleId: "m", contentVersion: "v" }], 50);
  assert.throws(
    () => lp.submitScore(score({ learnerId: "w", moduleId: "m", contentVersion: "v", correct: 11, total: 10 })),
    RangeError,
  );
  assert.throws(
    () => lp.submitScore(score({ learnerId: "w", moduleId: "m", contentVersion: "v", correct: 1, total: 0 })),
    RangeError,
  );
  close();
});

test("数据持久化：重新打开数据库后状态保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-test-"));
  const dbFile = join(dir, "test.db");
  const lp = new LearningPath(dbFile);
  lp.publishRevision([{ moduleId: "safety", contentVersion: "v1" }], 50);
  lp.submitScore(score({ learnerId: "w1", moduleId: "safety", contentVersion: "v1", correct: 8, total: 10 }));
  lp.close();

  const reopened = new LearningPath(dbFile);
  const progress = reopened.getProgress("w1");
  assert.equal(progress.allPassed, true);
  assert.equal(progress.currentBadgeEarned, true);
  assert.deepEqual(reopened.getBadges("w1").map((b) => b.revisionId), [1]);
  reopened.close();
});
