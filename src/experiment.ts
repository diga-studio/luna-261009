import { openDatabase } from "./db.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  ExperimentEvent,
  ExperimentResult,
  LockInfo,
  VariantStats,
} from "./types.js";

/** 判胜 Z 阈值 */
const Z_THRESHOLD = 1.959963984540054;
/** 每个变体判胜所需的最小有效曝光人数 */
const MIN_EXPOSURES = 200;

interface LockRow {
  winner_variant_id: string;
  trigger_event_id: string;
  snapshot_json: string;
}

/** A/B 实验判胜库主入口，由上层调用 */
export class ExperimentStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = openDatabase(filePath);
  }

  /** 建立实验：固定 2 至 5 个变体 */
  createExperiment(experimentId: string, variantIds: string[]): void {
    if (variantIds.length < 2 || variantIds.length > 5) {
      throw new Error("experiment must have 2 to 5 variants");
    }
    if (new Set(variantIds).size !== variantIds.length) {
      throw new Error("variant ids must be unique");
    }
    const existing = this.db
      .prepare("SELECT id FROM experiments WHERE id = ?")
      .get(experimentId);
    if (existing) {
      throw new Error(`experiment already exists: ${experimentId}`);
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO experiments (id) VALUES (?)").run(experimentId);
      const insertVariant = this.db.prepare(
        "INSERT INTO variants (experiment_id, variant_id) VALUES (?, ?)",
      );
      for (const variantId of variantIds) {
        insertVariant.run(experimentId, variantId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 接收事件批次，按输入次序逐条生效 */
  ingestBatch(experimentId: string, events: ExperimentEvent[]): void {
    this.assertExperiment(experimentId);
    this.db.exec("BEGIN");
    try {
      for (const event of events) {
        this.applyEvent(experimentId, event);
        this.tryLock(experimentId, event.eventId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 读取实验结果：实时统计 + 锁定结果 */
  getResult(experimentId: string): ExperimentResult {
    this.assertExperiment(experimentId);
    const stats = this.currentStats(experimentId);
    const lockRow = this.db
      .prepare(
        "SELECT winner_variant_id, trigger_event_id, snapshot_json FROM locks WHERE experiment_id = ?",
      )
      .get(experimentId) as LockRow | undefined;
    const lock: LockInfo | null = lockRow
      ? {
          winnerVariantId: lockRow.winner_variant_id,
          triggerEventId: lockRow.trigger_event_id,
          stats: JSON.parse(lockRow.snapshot_json) as VariantStats[],
        }
      : null;
    return { experimentId, stats, lock };
  }

  /** 关闭底层数据库连接 */
  close(): void {
    this.db.close();
  }

  private assertExperiment(experimentId: string): void {
    const row = this.db
      .prepare("SELECT id FROM experiments WHERE id = ?")
      .get(experimentId);
    if (!row) {
      throw new Error(`experiment not found: ${experimentId}`);
    }
  }

  private applyEvent(experimentId: string, event: ExperimentEvent): void {
    const variant = this.db
      .prepare(
        "SELECT variant_id FROM variants WHERE experiment_id = ? AND variant_id = ?",
      )
      .get(experimentId, event.variantId);
    if (!variant) {
      throw new Error(
        `unknown variant ${event.variantId} for experiment ${experimentId}`,
      );
    }
    // 事件标识去重：同一事件标识重复上报直接忽略
    const seen = this.db
      .prepare(
        "SELECT event_id FROM events WHERE experiment_id = ? AND event_id = ?",
      )
      .get(experimentId, event.eventId);
    if (seen) {
      return;
    }
    const seqRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE experiment_id = ?",
      )
      .get(experimentId) as { next: number };
    this.db
      .prepare(
        "INSERT INTO events (experiment_id, event_id, visitor_id, variant_id, type, seq) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        experimentId,
        event.eventId,
        event.visitorId,
        event.variantId,
        event.type,
        seqRow.next,
      );
    // 访客变体归属为可信输入且不变，以首次出现的归属建档
    this.db
      .prepare(
        "INSERT OR IGNORE INTO visitor_states (experiment_id, visitor_id, variant_id) VALUES (?, ?, ?)",
      )
      .run(experimentId, event.visitorId, event.variantId);
    if (event.type === "exposure") {
      this.db
        .prepare(
          "UPDATE visitor_states SET exposed = 1 WHERE experiment_id = ? AND visitor_id = ?",
        )
        .run(experimentId, event.visitorId);
    } else {
      this.db
        .prepare(
          "UPDATE visitor_states SET converted = 1 WHERE experiment_id = ? AND visitor_id = ?",
        )
        .run(experimentId, event.visitorId);
    }
  }

  /** 实时统计：n 为已曝光人数，c 为已曝光且已转化人数 */
  private currentStats(experimentId: string): VariantStats[] {
    const rows = this.db
      .prepare(
        `SELECT v.variant_id AS variant_id,
                COALESCE(SUM(s.exposed), 0) AS n,
                COALESCE(SUM(s.exposed AND s.converted), 0) AS c
         FROM variants v
         LEFT JOIN visitor_states s
           ON s.experiment_id = v.experiment_id AND s.variant_id = v.variant_id
         WHERE v.experiment_id = ?
         GROUP BY v.variant_id
         ORDER BY v.rowid`,
      )
      .all(experimentId) as unknown as { variant_id: string; n: number; c: number }[];
    return rows.map((row) => ({
      variantId: row.variant_id,
      n: Number(row.n),
      c: Number(row.c),
    }));
  }

  /** 单事件完整生效后检查判胜条件；已锁定则不再改动 */
  private tryLock(experimentId: string, triggerEventId: string): void {
    const locked = this.db
      .prepare("SELECT experiment_id FROM locks WHERE experiment_id = ?")
      .get(experimentId);
    if (locked) {
      return;
    }
    const stats = this.currentStats(experimentId);
    if (stats.some((s) => s.n < MIN_EXPOSURES)) {
      return;
    }
    for (const candidate of stats) {
      const winsAll = stats.every((other) => {
        if (other.variantId === candidate.variantId) {
          return true;
        }
        return zScore(candidate, other) >= Z_THRESHOLD;
      });
      if (winsAll) {
        this.db
          .prepare(
            "INSERT INTO locks (experiment_id, winner_variant_id, trigger_event_id, snapshot_json) VALUES (?, ?, ?, ?)",
          )
          .run(
            experimentId,
            candidate.variantId,
            triggerEventId,
            JSON.stringify(stats),
          );
        return;
      }
    }
  }
}

/** 双比例 Z 检验：a 相对 b 的 Z 值，分母为 0 时取 0 */
function zScore(a: VariantStats, b: VariantStats): number {
  const p = (a.c + b.c) / (a.n + b.n);
  const denominator = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  if (denominator === 0) {
    return 0;
  }
  return (a.c / a.n - b.c / b.n) / denominator;
}
