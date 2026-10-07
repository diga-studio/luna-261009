import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPathService, QuizAttempt } from "../src/index";

function makeService(): { svc: LearningPathService; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lps-test-"));
  const svc = new LearningPathService(join(dir, "test.db"));
  return {
    svc,
    cleanup: () => {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let attemptSeq = 0;
function attempt(partial: Omit<QuizAttempt, "attemptId"> & { attemptId?: string }): QuizAttempt {
  attemptSeq += 1;
  return { attemptId: `a-${attemptSeq}`, ...partial };
}

test("提高阈值后旧成绩可能不再达标，降低阈值后既有成绩立即达标（含未提交新成绩的学习者）", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1", "w2"]);
    svc.publishRevision({
      modules: [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      passPercent: 50,
    });
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 6, total: 10 }));
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m2", contentVersion: "v1", correct: 6, total: 10 }));
    svc.submitAttempt(attempt({ learnerId: "w2", moduleId: "m1", contentVersion: "v1", correct: 10, total: 10 }));
    svc.submitAttempt(attempt({ learnerId: "w2", moduleId: "m2", contentVersion: "v1", correct: 10, total: 10 }));

    let p1 = svc.getProgress("w1");
    assert.equal(p1.allPassed, true);
    assert.deepEqual(svc.getBadges("w1").map((b) => b.revisionId), [1]);

    // 提高阈值到 70%：w1 的 60% 成绩不再达标，w2 仍达标。
    svc.publishRevision({
      modules: [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      passPercent: 70,
    });
    p1 = svc.getProgress("w1");
    assert.equal(p1.revisionId, 2);
    assert.equal(p1.allPassed, false);
    assert.deepEqual(p1.modules.map((m) => m.passed), [false, false]);
    // 旧徽章永久保留，但不代表当前修订完成。
    assert.deepEqual(svc.getBadges("w1").map((b) => b.revisionId), [1]);
    // w2 没有提交新成绩，发布时按新标准重新结算，立即获得新徽章。
    assert.deepEqual(svc.getBadges("w2").map((b) => b.revisionId), [1, 2]);

    // 降低阈值到 60%：w1 的既有成绩立即达标，无需重考。
    svc.publishRevision({
      modules: [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      passPercent: 60,
    });
    assert.equal(svc.getProgress("w1").allPassed, true);
    assert.deepEqual(svc.getBadges("w1").map((b) => b.revisionId), [1, 3]);
  } finally {
    cleanup();
  }
});

test("模块移除后重新加入（同身份同版本）时历史成绩再次生效", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1"]);
    svc.publishRevision({
      modules: [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      passPercent: 50,
    });
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 5, total: 10 }));
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m2", contentVersion: "v1", correct: 5, total: 10 }));
    assert.equal(svc.getProgress("w1").allPassed, true);

    // 移除 m2：当前进度只看 m1。
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 50 });
    let p = svc.getProgress("w1");
    assert.deepEqual(p.modules.map((m) => m.moduleId), ["m1"]);
    assert.equal(p.allPassed, true);
    assert.deepEqual(svc.getBadges("w1").map((b) => b.revisionId), [1, 2]);

    // 重新加入 m2/v1：历史成绩复用，立即达标。
    svc.publishRevision({
      modules: [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      passPercent: 50,
    });
    p = svc.getProgress("w1");
    assert.equal(p.allPassed, true);
    assert.deepEqual(svc.getBadges("w1").map((b) => b.revisionId), [1, 2, 3]);
  } finally {
    cleanup();
  }
});

test("内容版本切换后收到旧版本成绩：保留但不贡献进度，切回旧版本时重新生效", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1"]);
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v2" }], passPercent: 50 });
    // 晚到的旧内容成绩（v1）。
    const late = attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 8, total: 10 });
    assert.equal(svc.submitAttempt(late).accepted, true);
    let p = svc.getProgress("w1");
    assert.equal(p.allPassed, false, "旧版本成绩不匹配当前 v2，不贡献进度");
    assert.deepEqual(svc.getBadges("w1"), []);

    // 当前版本成绩达标。
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v2", correct: 6, total: 10 }));
    assert.equal(svc.getProgress("w1").allPassed, true);

    // 修订切回 v1：晚到的旧成绩重新生效。
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 50 });
    p = svc.getProgress("w1");
    assert.equal(p.allPassed, true, "历史保留的 v1 成绩在切回后复用");
    assert.deepEqual(svc.getBadges("w1").map((b) => b.revisionId), [1, 2]);
  } finally {
    cleanup();
  }
});

test("相同版本标识不能跨模块身份复用", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1"]);
    svc.publishRevision({
      modules: [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      passPercent: 50,
    });
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 10, total: 10 }));
    const p = svc.getProgress("w1");
    assert.deepEqual(p.modules.map((m) => m.passed), [true, false]);
  } finally {
    cleanup();
  }
});

test("失败重考不覆盖已有达标成绩，重复提交只计一次且不重复授徽", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1"]);
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 50 });
    const good = attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 8, total: 10 });
    assert.equal(svc.submitAttempt(good).accepted, true);
    assert.equal(svc.getProgress("w1").allPassed, true);
    assert.equal(svc.getBadges("w1").length, 1);

    // 失败重考：已有达标证据不丢失。
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 1, total: 10 }));
    assert.equal(svc.getProgress("w1").allPassed, true);

    // 重复提交同一答题编号：被忽略。
    assert.equal(svc.submitAttempt(good).accepted, false);
    assert.equal(svc.getProgress("w1").allPassed, true);
    assert.equal(svc.getBadges("w1").length, 1, "徽章最多授予一次");
  } finally {
    cleanup();
  }
});

test("按精确比例判定：四舍五入后看似通过的成绩仍判未达标", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1"]);
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 67 });
    // 2/3 ≈ 66.67%，展示四舍五入为 67%，但精确比例不达标。
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 2, total: 3 }));
    assert.equal(svc.getProgress("w1").allPassed, false);
    assert.deepEqual(svc.getBadges("w1"), []);
    // 67/100 精确达标。
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 67, total: 100 }));
    assert.equal(svc.getProgress("w1").allPassed, true);
    assert.equal(svc.getBadges("w1").length, 1);
  } finally {
    cleanup();
  }
});

test("晚到成绩不补发已下线修订的徽章", () => {
  const { svc, cleanup } = makeService();
  try {
    svc.setLearners(["w1"]);
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 50 });
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 90 });
    // 成绩在修订 2 发布后才到，只参与修订 2 的结算。
    svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 6, total: 10 }));
    assert.deepEqual(svc.getBadges("w1"), [], "不为已下线的修订 1 补发徽章");
    const p = svc.getProgress("w1");
    assert.equal(p.revisionId, 2);
    assert.equal(p.allPassed, false);
  } finally {
    cleanup();
  }
});

test("输入校验：非法修订与成绩被拒绝", () => {
  const { svc, cleanup } = makeService();
  try {
    assert.throws(() => svc.publishRevision({ modules: [], passPercent: 50 }));
    assert.throws(() =>
      svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 0 })
    );
    assert.throws(() =>
      svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 101 })
    );
    assert.throws(() =>
      svc.publishRevision({
        modules: [
          { moduleId: "m1", contentVersion: "v1" },
          { moduleId: "m1", contentVersion: "v2" },
        ],
        passPercent: 50,
      })
    );
    svc.publishRevision({ modules: [{ moduleId: "m1", contentVersion: "v1" }], passPercent: 50 });
    assert.throws(() =>
      svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 11, total: 10 }))
    );
    assert.throws(() =>
      svc.submitAttempt(attempt({ learnerId: "w1", moduleId: "m1", contentVersion: "v1", correct: 1, total: 0 }))
    );
  } finally {
    cleanup();
  }
});

test("无修订时查询进度返回空状态", () => {
  const { svc, cleanup } = makeService();
  try {
    const p = svc.getProgress("w1");
    assert.equal(p.revisionId, null);
    assert.equal(p.allPassed, false);
    assert.deepEqual(svc.getBadges("w1"), []);
  } finally {
    cleanup();
  }
});
