import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db";
import {
  Badge,
  LearnerProgress,
  ModuleProgress,
  PublishRevisionInput,
  PublishResult,
  QuizAttempt,
  SubmitResult,
} from "./types";

const CURRENT_REVISION_KEY = "current_revision_id";

interface RevisionModuleRow {
  module_id: string;
  content_version: string;
}

/**
 * 学习路径达标结算服务。
 * 所有方法均为同步；每个写方法在单个事务内完成，
 * 返回时受影响的当前进度与徽章已一起生效。
 */
export class LearningPathService {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 登记学习者（增量）；通过成绩出现的学习者也会自动登记。 */
  setLearners(learnerIds: string[]): void {
    for (const id of learnerIds) {
      requireNonEmpty(id, "learnerId");
    }
    this.inTransaction(() => {
      const stmt = this.db.prepare(
        "INSERT OR IGNORE INTO learners (learner_id) VALUES (?)"
      );
      for (const id of learnerIds) {
        stmt.run(id);
      }
    });
  }

  /** 发布新修订并立即成为当前修订，所有学习者按新标准重新结算。 */
  publishRevision(input: PublishRevisionInput): PublishResult {
    validateRevisionInput(input);
    return this.inTransaction(() => {
      const createdAt = new Date().toISOString();
      const revisionId = Number(
        this.db
          .prepare("INSERT INTO revisions (pass_percent, created_at) VALUES (?, ?)")
          .run(input.passPercent, createdAt).lastInsertRowid
      );
      const insertModule = this.db.prepare(
        "INSERT INTO revision_modules (revision_id, module_id, content_version, position) VALUES (?, ?, ?, ?)"
      );
      input.modules.forEach((m, index) => {
        insertModule.run(revisionId, m.moduleId, m.contentVersion, index);
      });
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(CURRENT_REVISION_KEY, String(revisionId));
      // 按新标准重新结算：全部模块达标即授予当前修订徽章。
      const grantBadge = this.db.prepare(
        "INSERT OR IGNORE INTO badges (learner_id, revision_id, granted_at) VALUES (?, ?, ?)"
      );
      const learners = this.db
        .prepare("SELECT learner_id FROM learners")
        .all() as Array<{ learner_id: string }>;
      for (const row of learners) {
        if (this.countUnpassedModules(row.learner_id, revisionId, input.passPercent) === 0) {
          grantBadge.run(row.learner_id, revisionId, createdAt);
        }
      }
      return { revisionId };
    });
  }

  /** 接收一条测验成绩；重复答题编号只计入一次。 */
  submitAttempt(attempt: QuizAttempt): SubmitResult {
    validateAttempt(attempt);
    return this.inTransaction(() => {
      const receivedAt = new Date().toISOString();
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO attempts (attempt_id, learner_id, module_id, content_version, correct, total, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          attempt.attemptId,
          attempt.learnerId,
          attempt.moduleId,
          attempt.contentVersion,
          attempt.correct,
          attempt.total,
          receivedAt
        );
      if (Number(result.changes) === 0) {
        return { accepted: false };
      }
      this.db
        .prepare("INSERT OR IGNORE INTO learners (learner_id) VALUES (?)")
        .run(attempt.learnerId);
      const revisionId = this.currentRevisionId();
      if (revisionId !== null) {
        const passPercent = this.revisionPassPercent(revisionId);
        if (this.countUnpassedModules(attempt.learnerId, revisionId, passPercent) === 0) {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO badges (learner_id, revision_id, granted_at) VALUES (?, ?, ?)"
            )
            .run(attempt.learnerId, revisionId, receivedAt);
        }
      }
      return { accepted: true };
    });
  }

  /** 读取学习者相对当前修订的进度。 */
  getProgress(learnerId: string): LearnerProgress {
    requireNonEmpty(learnerId, "learnerId");
    return this.inTransaction(() => {
      const revisionId = this.currentRevisionId();
      if (revisionId === null) {
        return { learnerId, revisionId: null, modules: [], allPassed: false };
      }
      const passPercent = this.revisionPassPercent(revisionId);
      const rows = this.db
        .prepare(
          "SELECT module_id, content_version FROM revision_modules WHERE revision_id = ? ORDER BY position"
        )
        .all(revisionId) as unknown as RevisionModuleRow[];
      const passStmt = this.db.prepare(
        "SELECT 1 AS ok FROM attempts WHERE learner_id = ? AND module_id = ? AND content_version = ? AND correct * 100 >= ? * total LIMIT 1"
      );
      const modules: ModuleProgress[] = rows.map((row) => {
        const passed =
          passStmt.get(learnerId, row.module_id, row.content_version, passPercent) !==
          undefined;
        return {
          moduleId: row.module_id,
          contentVersion: row.content_version,
          passed,
        };
      });
      return {
        learnerId,
        revisionId,
        modules,
        allPassed: modules.every((m) => m.passed),
      };
    });
  }

  /** 读取学习者的历史徽章（含已下线修订）。 */
  getBadges(learnerId: string): Badge[] {
    requireNonEmpty(learnerId, "learnerId");
    return this.inTransaction(() => {
      const rows = this.db
        .prepare(
          "SELECT revision_id, granted_at FROM badges WHERE learner_id = ? ORDER BY revision_id"
        )
        .all(learnerId) as unknown as Array<{ revision_id: number; granted_at: string }>;
      return rows.map((row) => ({
        learnerId,
        revisionId: row.revision_id,
        grantedAt: row.granted_at,
      }));
    });
  }

  /** 关闭底层数据库连接。 */
  close(): void {
    this.db.close();
  }

  private currentRevisionId(): number | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(CURRENT_REVISION_KEY) as { value: string } | undefined;
    return row === undefined ? null : Number(row.value);
  }

  private revisionPassPercent(revisionId: number): number {
    const row = this.db
      .prepare("SELECT pass_percent FROM revisions WHERE id = ?")
      .get(revisionId) as { pass_percent: number };
    return row.pass_percent;
  }

  /** 统计学习者在指定修订下未达标的模块数（精确比例判定，不四舍五入）。 */
  private countUnpassedModules(
    learnerId: string,
    revisionId: number,
    passPercent: number
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM revision_modules rm
         WHERE rm.revision_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM attempts a
             WHERE a.learner_id = ?
               AND a.module_id = rm.module_id
               AND a.content_version = rm.content_version
               AND a.correct * 100 >= ? * a.total
           )`
      )
      .get(revisionId, learnerId, passPercent) as { n: number };
    return Number(row.n);
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function validateRevisionInput(input: PublishRevisionInput): void {
  if (!Number.isInteger(input.passPercent) || input.passPercent < 1 || input.passPercent > 100) {
    throw new RangeError("passPercent 必须是 1 至 100 的整数");
  }
  if (!Array.isArray(input.modules) || input.modules.length < 1 || input.modules.length > 30) {
    throw new RangeError("每个修订必须包含 1 至 30 个模块");
  }
  const seen = new Set<string>();
  for (const m of input.modules) {
    requireNonEmpty(m.moduleId, "moduleId");
    requireNonEmpty(m.contentVersion, "contentVersion");
    if (seen.has(m.moduleId)) {
      throw new Error(`模块身份重复: ${m.moduleId}`);
    }
    seen.add(m.moduleId);
  }
}

function validateAttempt(attempt: QuizAttempt): void {
  requireNonEmpty(attempt.attemptId, "attemptId");
  requireNonEmpty(attempt.learnerId, "learnerId");
  requireNonEmpty(attempt.moduleId, "moduleId");
  requireNonEmpty(attempt.contentVersion, "contentVersion");
  if (!Number.isInteger(attempt.total) || attempt.total < 1) {
    throw new RangeError("total 必须是大于等于 1 的整数");
  }
  if (
    !Number.isInteger(attempt.correct) ||
    attempt.correct < 0 ||
    attempt.correct > attempt.total
  ) {
    throw new RangeError("correct 必须是 0 至 total 之间的整数");
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} 必须是非空字符串`);
  }
}
