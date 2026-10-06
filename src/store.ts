import { openDatabase } from './db.js';
import { computeWinner } from './judge.js';
import type { ExperimentEvent, ExperimentResult, LockRecord, VariantStats } from './types.js';
import type { DatabaseSync } from 'node:sqlite';

interface ExperimentRow {
  id: string;
  variants: string;
  locked_winner: string | null;
  lock_event_id: string | null;
  lock_stats: string | null;
}

interface VisitorRow {
  variant: string;
  exposed: number;
  converted: number;
  pending_conversion: number;
}

export class ExperimentStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = openDatabase(filePath);
  }

  createExperiment(experimentId: string, variants: string[]): void {
    if (!Array.isArray(variants) || variants.length < 2 || variants.length > 5) {
      throw new Error('an experiment requires 2 to 5 variants');
    }
    if (new Set(variants).size !== variants.length) {
      throw new Error('variant names must be unique');
    }
    const existing = this.db
      .prepare('SELECT id FROM experiments WHERE id = ?')
      .get(experimentId) as { id: string } | undefined;
    if (existing) {
      throw new Error(`experiment already exists: ${experimentId}`);
    }
    this.db
      .prepare('INSERT INTO experiments (id, variants) VALUES (?, ?)')
      .run(experimentId, JSON.stringify(variants));
  }

  ingestBatch(experimentId: string, events: ExperimentEvent[]): void {
    const experiment = this.requireExperiment(experimentId);
    const variants = JSON.parse(experiment.variants) as string[];
    let locked = experiment.locked_winner !== null;

    this.db.exec('BEGIN');
    try {
      const seqRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE experiment_id = ?')
        .get(experimentId) as { max_seq: number };
      let seq = seqRow.max_seq;

      for (const event of events) {
        seq += 1;
        if (!variants.includes(event.variant)) {
          throw new Error(`unknown variant "${event.variant}" for experiment ${experimentId}`);
        }
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO events
             (experiment_id, event_id, visitor_id, variant, type, seq)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(experimentId, event.eventId, event.visitorId, event.variant, event.type, seq);
        if (Number(inserted.changes) === 0) {
          continue;
        }
        this.applyEvent(experimentId, event);
        if (!locked) {
          const stats = this.collectStats(experimentId, variants);
          const winner = computeWinner(stats);
          if (winner !== null) {
            this.db
              .prepare(
                'UPDATE experiments SET locked_winner = ?, lock_event_id = ?, lock_stats = ? WHERE id = ?',
              )
              .run(winner, event.eventId, JSON.stringify(stats), experimentId);
            locked = true;
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getResult(experimentId: string): ExperimentResult {
    const experiment = this.requireExperiment(experimentId);
    const variants = JSON.parse(experiment.variants) as string[];
    const lock: LockRecord | null =
      experiment.locked_winner !== null
        ? {
            winner: experiment.locked_winner,
            triggerEventId: experiment.lock_event_id as string,
            stats: JSON.parse(experiment.lock_stats as string) as VariantStats[],
          }
        : null;
    return {
      experimentId,
      variants: this.collectStats(experimentId, variants),
      lock,
    };
  }

  close(): void {
    this.db.close();
  }

  private requireExperiment(experimentId: string): ExperimentRow {
    const row = this.db
      .prepare('SELECT * FROM experiments WHERE id = ?')
      .get(experimentId) as ExperimentRow | undefined;
    if (!row) {
      throw new Error(`experiment not found: ${experimentId}`);
    }
    return row;
  }

  private applyEvent(experimentId: string, event: ExperimentEvent): void {
    let visitor = this.db
      .prepare(
        'SELECT variant, exposed, converted, pending_conversion FROM visitor_state WHERE experiment_id = ? AND visitor_id = ?',
      )
      .get(experimentId, event.visitorId) as VisitorRow | undefined;
    if (!visitor) {
      this.db
        .prepare(
          'INSERT INTO visitor_state (experiment_id, visitor_id, variant) VALUES (?, ?, ?)',
        )
        .run(experimentId, event.visitorId, event.variant);
      visitor = { variant: event.variant, exposed: 0, converted: 0, pending_conversion: 0 };
    }

    if (event.type === 'exposure') {
      if (visitor.exposed === 1) {
        return;
      }
      const backfill = visitor.pending_conversion === 1 && visitor.converted === 0;
      this.db
        .prepare(
          `UPDATE visitor_state
           SET exposed = 1, converted = ?, pending_conversion = 0
           WHERE experiment_id = ? AND visitor_id = ?`,
        )
        .run(backfill ? 1 : visitor.converted, experimentId, event.visitorId);
    } else {
      if (visitor.converted === 1 || visitor.pending_conversion === 1) {
        return;
      }
      if (visitor.exposed === 1) {
        this.db
          .prepare(
            'UPDATE visitor_state SET converted = 1 WHERE experiment_id = ? AND visitor_id = ?',
          )
          .run(experimentId, event.visitorId);
      } else {
        this.db
          .prepare(
            'UPDATE visitor_state SET pending_conversion = 1 WHERE experiment_id = ? AND visitor_id = ?',
          )
          .run(experimentId, event.visitorId);
      }
    }
  }

  private collectStats(experimentId: string, variants: string[]): VariantStats[] {
    const rows = this.db
      .prepare(
        `SELECT variant, SUM(exposed) AS n, SUM(converted) AS c
         FROM visitor_state WHERE experiment_id = ? GROUP BY variant`,
      )
      .all(experimentId) as Array<{ variant: string; n: number; c: number }>;
    const byVariant = new Map(rows.map((row) => [row.variant, row]));
    return variants.map((variant) => {
      const row = byVariant.get(variant);
      return { variant, n: Number(row?.n ?? 0), c: Number(row?.c ?? 0) };
    });
  }
}
