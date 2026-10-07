import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LearnerProgress,
  LearningPathService,
  ModuleSpec,
} from "../src/index";

interface RevisionRec {
  id: number;
  modules: ModuleSpec[];
  passPercent: number;
}
interface AttemptRec {
  learnerId: string;
  moduleId: string;
  contentVersion: string;
  correct: number;
  total: number;
}
type Op =
  | { kind: "publish"; rev: RevisionRec }
  | { kind: "attempt"; accepted: boolean; attempt: AttemptRec };

/** 依据操作日志独立重放，计算某学习者对指定修订的达标情况。 */
function modelAllPassed(
  rev: RevisionRec,
  learnerId: string,
  attempts: AttemptRec[]
): boolean {
  return rev.modules.every((m) =>
    attempts.some(
      (a) =>
        a.learnerId === learnerId &&
        a.moduleId === m.moduleId &&
        a.contentVersion === m.contentVersion &&
        a.correct * 100 >= rev.passPercent * a.total
    )
  );
}

test("并发发布、接收与读取：进度与独立重放结果一致，徽章与进度同事务生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lps-conc-"));
  const svc = new LearningPathService(join(dir, "test.db"));
  try {
    const learners = ["w1", "w2", "w3", "w4", "w5"];
    svc.setLearners(learners);

    const ops: Op[] = [];
    const revisions: RevisionRec[] = [];
    let attemptSeq = 0;

    // 模块池：m1/m2 在 v1/v2 间切换，m3 时而被移除。
    const moduleSets: ModuleSpec[][] = [
      [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m2", contentVersion: "v1" },
      ],
      [
        { moduleId: "m1", contentVersion: "v2" },
        { moduleId: "m2", contentVersion: "v1" },
        { moduleId: "m3", contentVersion: "v1" },
      ],
      [
        { moduleId: "m1", contentVersion: "v1" },
        { moduleId: "m3", contentVersion: "v1" },
      ],
    ];
    const passPercents = [50, 70, 40, 80, 60];

    const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

    const doPublish = async (i: number) => {
      await yieldNow();
      const modules = moduleSets[i % moduleSets.length]!;
      const passPercent = passPercents[i % passPercents.length]!;
      const { revisionId } = svc.publishRevision({ modules, passPercent });
      const rev: RevisionRec = { id: revisionId, modules, passPercent };
      revisions.push(rev);
      ops.push({ kind: "publish", rev });
    };

    const doAttempt = async (i: number) => {
      await yieldNow();
      attemptSeq += 1;
      const learnerId = learners[i % learners.length]!;
      const moduleId = ["m1", "m2", "m3"][i % 3]!;
      const contentVersion = i % 4 === 0 ? "v1" : i % 4 === 1 ? "v2" : "v1";
      const correct = (i * 7) % 11;
      const attempt: AttemptRec = {
        learnerId,
        moduleId,
        contentVersion,
        correct,
        total: 10,
      };
      const attemptId = `conc-${attemptSeq}`;
      const res = svc.submitAttempt({ attemptId, ...attempt });
      ops.push({ kind: "attempt", accepted: res.accepted, attempt });
      // 偶发重复提交。
      if (i % 5 === 0) {
        await yieldNow();
        const dup = svc.submitAttempt({ attemptId, ...attempt });
        ops.push({ kind: "attempt", accepted: dup.accepted, attempt });
      }
    };

    const progressChecks: LearnerProgress[] = [];
    const doRead = async (i: number) => {
      await yieldNow();
      const learnerId = learners[i % learners.length]!;
      const p = svc.getProgress(learnerId);
      progressChecks.push(p);
      if (p.revisionId !== null) {
        // 读到的修订必须真实存在，模块列表必须与该修订一致。
        const rev = revisions.find((r) => r.id === p.revisionId)!;
        assert.deepEqual(
          p.modules.map((m) => ({ moduleId: m.moduleId, contentVersion: m.contentVersion })),
          rev.modules,
          "不得读到新修订配旧模块状态"
        );
        if (p.allPassed) {
          // 全部达标时，当前修订徽章必须已经授予（徽章只增不减）。
          const badges = svc.getBadges(learnerId);
          assert.ok(
            badges.some((b) => b.revisionId === p.revisionId),
            "全部达标却尚未授予当前徽章"
          );
        }
      }
    };

    // 交错并发执行。
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 12; i++) tasks.push(doPublish(i));
    for (let i = 0; i < 120; i++) tasks.push(doAttempt(i));
    for (let i = 0; i < 60; i++) tasks.push(doRead(i));
    await Promise.all(tasks);

    // 重放操作日志，独立计算最终状态。
    const accepted: AttemptRec[] = [];
    const expectedBadges = new Map<string, Set<number>>();
    let current: RevisionRec | null = null;
    for (const op of ops) {
      if (op.kind === "publish") {
        current = op.rev;
        for (const learnerId of learners) {
          if (modelAllPassed(current, learnerId, accepted)) {
            const set = expectedBadges.get(learnerId) ?? new Set<number>();
            set.add(current.id);
            expectedBadges.set(learnerId, set);
          }
        }
      } else if (op.accepted) {
        accepted.push(op.attempt);
        if (current !== null && modelAllPassed(current, op.attempt.learnerId, accepted)) {
          const set = expectedBadges.get(op.attempt.learnerId) ?? new Set<number>();
          set.add(current.id);
          expectedBadges.set(op.attempt.learnerId, set);
        }
      }
    }

    const finalRev = revisions[revisions.length - 1]!;
    for (const learnerId of learners) {
      const p = svc.getProgress(learnerId);
      assert.equal(p.revisionId, finalRev.id);
      assert.equal(
        p.allPassed,
        modelAllPassed(finalRev, learnerId, accepted),
        `学习者 ${learnerId} 的最终进度须与独立重放一致`
      );
      const expected = [...(expectedBadges.get(learnerId) ?? new Set<number>())].sort(
        (a, b) => a - b
      );
      assert.deepEqual(
        svc.getBadges(learnerId).map((b) => b.revisionId),
        expected,
        `学习者 ${learnerId} 的历史徽章须与独立重放一致`
      );
    }
    assert.ok(progressChecks.length > 0);
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
