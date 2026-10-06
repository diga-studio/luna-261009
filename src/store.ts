import { DatabaseSync } from "node:sqlite";
import { StepParseError, type EntityRecord, type EntityResult } from "./types.js";

/**
 * SQLite-backed persistence for entities and references.
 * An import runs inside a single transaction: on failure the previous
 * index content is left untouched.
 */
export class Store {
  private readonly db: DatabaseSync;
  private insEntity?: ReturnType<DatabaseSync["prepare"]>;
  private insRef?: ReturnType<DatabaseSync["prepare"]>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refs (
        src INTEGER NOT NULL,
        dst INTEGER NOT NULL,
        PRIMARY KEY (src, dst)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS refs_dst ON refs(dst);
    `);
  }

  begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
    this.db.exec("DELETE FROM refs");
    this.db.exec("DELETE FROM entities");
  }

  insertEntity(rec: EntityRecord, refs: readonly string[]): void {
    const id = BigInt(rec.id);
    this.insEntity ??= this.db.prepare("INSERT INTO entities (id, body) VALUES (?, ?)");
    try {
      this.insEntity.run(id, JSON.stringify(rec));
    } catch (e) {
      if (e instanceof Error && /UNIQUE|PRIMARY KEY/i.test(e.message)) {
        throw new StepParseError(`duplicate entity id #${rec.id}`);
      }
      throw e;
    }
    this.insRef ??= this.db.prepare("INSERT OR IGNORE INTO refs (src, dst) VALUES (?, ?)");
    for (const r of refs) {
      this.insRef.run(id, BigInt(r));
    }
  }

  /** Throws if any referenced id was never defined. */
  validateRefs(): void {
    const stmt = this.db.prepare(
      `SELECT r.dst AS dst FROM refs r
       LEFT JOIN entities e ON e.id = r.dst
       WHERE e.id IS NULL LIMIT 1`,
    );
    stmt.setReadBigInts(true);
    const row = stmt.get() as { dst: bigint } | undefined;
    if (row !== undefined) {
      throw new StepParseError(`reference to undefined entity #${row.dst}`);
    }
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  getEntity(id: string): EntityResult | null {
    const row = this.db
      .prepare("SELECT body FROM entities WHERE id = ?")
      .get(BigInt(id)) as { body: string } | undefined;
    if (row === undefined) return null;
    const rec = JSON.parse(row.body) as EntityRecord;
    const fwdStmt = this.db.prepare("SELECT dst AS id FROM refs WHERE src = ? ORDER BY dst");
    fwdStmt.setReadBigInts(true);
    const fwd = fwdStmt.all(BigInt(id)) as unknown as { id: bigint }[];
    const bwdStmt = this.db.prepare("SELECT src AS id FROM refs WHERE dst = ? ORDER BY src");
    bwdStmt.setReadBigInts(true);
    const bwd = bwdStmt.all(BigInt(id)) as unknown as { id: bigint }[];
    return {
      ...rec,
      forwardRefs: fwd.map((r) => r.id.toString()),
      backwardRefs: bwd.map((r) => r.id.toString()),
    };
  }

  entityCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
