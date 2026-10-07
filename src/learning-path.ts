import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import type {
  Badge,
  ModuleSpec,
  ProgressSnapshot,
  PublishResult,
  ScoreSubmission,
  SubmitResult,
} from "./types.js";

interface RevisionRow {
  id: number;
  pass_percent: number;
}

interface ModuleRow {
  module_id: string;
  content_version: string;
}

/**
 * 学习路径达标结算库入口。
 * 同一进程内的调用被串行化；每次调用成功返回时，其影响已完整生效。
 */
export class LearningPath {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 发布一个不可修改的新修订，并立即成为当前修订；所有学习者按新标准重新结算。 */
  publishRevision(modules: ModuleSpec[], passPercent: number): PublishResult {
    validateRevisionInput(modules, passPercent);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const insertRevision = this.db.prepare(
        "INSERT INTO revisions (pass_percent, created_at) VALUES (?, ?)",
      );
      const result = insertRevision.run(passPercent, now);
      const revisionId = Number(result.lastInsertRowid);

      const insertModule = this.db.prepare(
        "INSERT INTO revision_modules (revision_id, module_id, content_version, position) VALUES (?, ?, ?, ?)",
      );
      modules.forEach((mod, index) => {
        insertModule.run(revisionId, mod.moduleId, mod.contentVersion, index);
      });

      const learners = this.db
        .prepare("SELECT DISTINCT learner_id FROM scores")
        .all() as Array<{ learner_id: string }>;
      for (const learner of learners) {
        this.settleLearner(learner.learner_id, revisionId, passPercent);
      }

      this.db.exec("COMMIT");
      return { revisionId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 接收一条测验成绩（允许乱序与重复提交；重复提交只计入一次）。 */
  submitScore(score: ScoreSubmission): SubmitResult {
    validateScoreInput(score);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO scores
         (attempt_id, learner_id, module_id, content_version, correct, total, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const result = insert.run(
        score.attemptId,
        score.learnerId,
        score.moduleId,
        score.contentVersion,
        score.correct,
        score.total,
        new Date().toISOString(),
      );
      if (result.changes === 0) {
        this.db.exec("COMMIT");
        return { accepted: false };
      }

      const revision = this.currentRevision();
      if (revision !== null) {
        this.settleLearner(score.learnerId, revision.id, revision.pass_percent);
      }

      this.db.exec("COMMIT");
      return { accepted: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 读取学习者相对当前修订的进度快照。 */
  getProgress(learnerId: string): ProgressSnapshot {
    this.db.exec("BEGIN");
    try {
      const revision = this.currentRevision();
      if (revision === null) {
        throw new Error("no revision has been published yet");
      }
      const modules = this.db
        .prepare(
          "SELECT module_id, content_version FROM revision_modules WHERE revision_id = ? ORDER BY position",
        )
        .all(revision.id) as unknown as ModuleRow[];
      const passedStmt = this.db.prepare(
        `SELECT EXISTS(
           SELECT 1 FROM scores
           WHERE learner_id = ? AND module_id = ? AND content_version = ?
             AND correct * 100 >= total * ?
         ) AS passed`,
      );
      const progress = modules.map((mod) => {
        const row = passedStmt.get(
          learnerId,
          mod.module_id,
          mod.content_version,
          revision.pass_percent,
        ) as { passed: number };
        return {
          moduleId: mod.module_id,
          contentVersion: mod.content_version,
          passed: row.passed === 1,
        };
      });
      const badgeRow = this.db
        .prepare(
          "SELECT 1 AS earned FROM badges WHERE learner_id = ? AND revision_id = ?",
        )
        .get(learnerId, revision.id) as { earned: number } | undefined;
      const snapshot: ProgressSnapshot = {
        revisionId: revision.id,
        passPercent: revision.pass_percent,
        modules: progress,
        allPassed: progress.every((mod) => mod.passed),
        currentBadgeEarned: badgeRow !== undefined,
      };
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 读取学习者的历史徽章（含当前修订，若已授予）。 */
  getBadges(learnerId: string): Badge[] {
    const rows = this.db
      .prepare(
        "SELECT revision_id, earned_at FROM badges WHERE learner_id = ? ORDER BY revision_id",
      )
      .all(learnerId) as unknown as Array<{
      revision_id: number;
      earned_at: string;
    }>;
    return rows.map((row) => ({
      revisionId: row.revision_id,
      earnedAt: row.earned_at,
    }));
  }

  /** 关闭底层数据库连接。 */
  close(): void {
    this.db.close();
  }

  private currentRevision(): RevisionRow | null {
    const row = this.db
      .prepare(
        "SELECT id, pass_percent FROM revisions ORDER BY id DESC LIMIT 1",
      )
      .get() as RevisionRow | undefined;
    return row ?? null;
  }

  /**
   * 按指定修订结算单个学习者：全部模块达标则授予该修订徽章（最多一次）。
   * 仅在发布或接收成绩时对当前修订调用，因此晚到成绩不会补发已下线修订的徽章。
   */
  private settleLearner(
    learnerId: string,
    revisionId: number,
    passPercent: number,
  ): void {
    const unpassed = this.db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM revision_modules rm
           WHERE rm.revision_id = ?
             AND NOT EXISTS(
               SELECT 1 FROM scores s
               WHERE s.learner_id = ?
                 AND s.module_id = rm.module_id
                 AND s.content_version = rm.content_version
                 AND s.correct * 100 >= s.total * ?
             )
         ) AS has_unpassed`,
      )
      .get(revisionId, learnerId, passPercent) as { has_unpassed: number };
    if (unpassed.has_unpassed === 1) {
      return;
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO badges (learner_id, revision_id, earned_at) VALUES (?, ?, ?)",
      )
      .run(learnerId, revisionId, new Date().toISOString());
  }
}

function validateRevisionInput(modules: ModuleSpec[], passPercent: number): void {
  if (!Number.isInteger(passPercent) || passPercent < 1 || passPercent > 100) {
    throw new RangeError("passPercent must be an integer between 1 and 100");
  }
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 30) {
    throw new RangeError("a revision must contain between 1 and 30 modules");
  }
  const seen = new Set<string>();
  for (const mod of modules) {
    if (!mod.moduleId || !mod.contentVersion) {
      throw new TypeError("moduleId and contentVersion must be non-empty strings");
    }
    if (seen.has(mod.moduleId)) {
      throw new RangeError(`duplicate moduleId in revision: ${mod.moduleId}`);
    }
    seen.add(mod.moduleId);
  }
}

function validateScoreInput(score: ScoreSubmission): void {
  if (
    !score.learnerId ||
    !score.attemptId ||
    !score.moduleId ||
    !score.contentVersion
  ) {
    throw new TypeError(
      "learnerId, attemptId, moduleId and contentVersion must be non-empty strings",
    );
  }
  if (!Number.isInteger(score.total) || score.total < 1) {
    throw new RangeError("total must be a positive integer");
  }
  if (
    !Number.isInteger(score.correct) ||
    score.correct < 0 ||
    score.correct > score.total
  ) {
    throw new RangeError("correct must be an integer between 0 and total");
  }
}
