import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.js";
import type { ChunkInput, SearchHit } from "./types.js";

/**
 * 本地知识检索库。单进程顺序调用。
 * 原文、文档版本与检索数据全部存入 SQLite。
 */
export class KnowledgeStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * 提交文档的一个完整新版本，返回版本 ID。
   * 提交后该版本成为文档的当前版本；旧版本保留但不参与检索。
   */
  submitVersion(kbId: string, docId: string, chunks: ChunkInput[]): number {
    this.db.exec("BEGIN");
    try {
      const versionId = Number(
        this.db
          .prepare("INSERT INTO versions (kb_id, doc_id) VALUES (?, ?)")
          .run(kbId, docId).lastInsertRowid,
      );

      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (version_id, seq, text, len) VALUES (?, ?, ?, ?)",
      );
      const insertTerm = this.db.prepare(
        "INSERT INTO chunk_terms (version_id, term, seq, tf, len) VALUES (?, ?, ?, ?, ?)",
      );

      let totalLen = 0;
      for (let seq = 0; seq < chunks.length; seq++) {
        const chunk = chunks[seq];
        const len = chunk.terms.length;
        insertChunk.run(versionId, seq, chunk.text, len);
        totalLen += len;
        // 按完全相等聚合同一块内重复词项
        const tf = new Map<string, number>();
        for (const term of chunk.terms) {
          tf.set(term, (tf.get(term) ?? 0) + 1);
        }
        for (const [term, count] of tf) {
          insertTerm.run(versionId, term, seq, count, len);
        }
      }

      this.db
        .prepare(
          `INSERT INTO documents (kb_id, doc_id, current_version_id, active_chunks, active_len)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (kb_id, doc_id)
           DO UPDATE SET current_version_id = excluded.current_version_id,
                         active_chunks = excluded.active_chunks,
                         active_len = excluded.active_len`,
        )
        .run(kbId, docId, versionId, chunks.length, totalLen);

      this.db.exec("COMMIT");
      return versionId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 将文档回滚到指定历史版本（仅切换当前版本，不改写历史）。 */
  rollback(kbId: string, docId: string, versionId: number): void {
    const version = this.db
      .prepare("SELECT kb_id, doc_id FROM versions WHERE version_id = ?")
      .get(versionId);
    if (!version || version.kb_id !== kbId || version.doc_id !== docId) {
      throw new Error(
        `version ${versionId} does not belong to document ${kbId}/${docId}`,
      );
    }
    const stats = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(len), 0) AS total FROM chunks WHERE version_id = ?",
      )
      .get(versionId)!;
    this.db
      .prepare(
        `INSERT INTO documents (kb_id, doc_id, current_version_id, active_chunks, active_len)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kb_id, doc_id)
         DO UPDATE SET current_version_id = excluded.current_version_id,
                       active_chunks = excluded.active_chunks,
                       active_len = excluded.active_len`,
      )
      .run(kbId, docId, versionId, Number(stats.n), Number(stats.total));
  }

  /**
   * 在不超过 10 个已绑定知识库范围内检索，返回得分最高的 5 个块。
   * 重复查询词只计算一次；仅统计各文档当前版本。
   */
  search(kbIds: string[], queryTerms: string[]): SearchHit[] {
    if (kbIds.length > 10) {
      throw new Error(`at most 10 knowledge bases per search, got ${kbIds.length}`);
    }
    const kbs = [...new Set(kbIds)];
    // 重复查询词只计算一次；排序使浮点累加顺序确定
    const terms = [...new Set(queryTerms)].sort();
    if (kbs.length === 0 || terms.length === 0) {
      return [];
    }

    const kbSlots = kbs.map(() => "?").join(", ");

    // N = 范围内活跃块数；avgL = 活跃块平均词项数（无词项块长度 0 仍计入）
    const scope = this.db
      .prepare(
        `SELECT COALESCE(SUM(active_chunks), 0) AS n, COALESCE(SUM(active_len), 0) AS total
         FROM documents WHERE kb_id IN (${kbSlots})`,
      )
      .get(...kbs)!;
    const N = Number(scope.n);
    if (N === 0) {
      return [];
    }
    const avgL = Number(scope.total) / N;

    // 范围内各文档的当前版本
    const versionRows = this.db
      .prepare(
        `SELECT kb_id, doc_id, current_version_id FROM documents
         WHERE kb_id IN (${kbSlots}) AND current_version_id IS NOT NULL`,
      )
      .all(...kbs);
    const versionInfo = new Map<number, { kbId: string; docId: string }>();
    const versionIds: number[] = [];
    for (const row of versionRows) {
      const id = Number(row.current_version_id);
      versionIds.push(id);
      versionInfo.set(id, { kbId: String(row.kb_id), docId: String(row.doc_id) });
    }

    const vSlots = versionIds.map(() => "?").join(", ");
    const tSlots = terms.map(() => "?").join(", ");
    const params = [...versionIds, ...terms];

    // df = 范围内包含该词的活跃块数
    const dfRows = this.db
      .prepare(
        `SELECT term, COUNT(*) AS df FROM chunk_terms
         WHERE version_id IN (${vSlots}) AND term IN (${tSlots})
         GROUP BY term`,
      )
      .all(...params);
    if (dfRows.length === 0) {
      return [];
    }
    const idf = new Map<string, number>();
    for (const row of dfRows) {
      const df = Number(row.df);
      idf.set(String(row.term), Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }

    // 流式扫描命中块并累加 BM25 得分。
    // 注意：聚簇主键 (version_id, term, seq) 保证同一块的各行按词项序到达，
    // 与参考实现按排序后词项累加的顺序一致，分数逐位相等。
    const rows = this.db
      .prepare(
        `SELECT version_id, term, seq, tf, len FROM chunk_terms
         WHERE version_id IN (${vSlots}) AND term IN (${tSlots})`,
      )
      .iterate(...params);

    const acc = new Map<string, SearchHit>();
    for (const row of rows) {
      const term = String(row.term);
      const tf = Number(row.tf);
      const len = Number(row.len);
      const contribution =
        (idf.get(term)! * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * len) / avgL));
      const versionId = Number(row.version_id);
      const seq = Number(row.seq);
      const key = `${versionId}:${seq}`;
      let hit = acc.get(key);
      if (!hit) {
        const info = versionInfo.get(versionId)!;
        hit = { kbId: info.kbId, docId: info.docId, versionId, seq, text: "", score: 0 };
        acc.set(key, hit);
      }
      hit.score += contribution;
    }

    const hits = [...acc.values()];
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        (a.kbId < b.kbId ? -1 : a.kbId > b.kbId ? 1 : 0) ||
        (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
        a.seq - b.seq,
    );
    const top = hits.slice(0, 5);

    // 只为最终命中的块取原文
    const textStmt = this.db.prepare(
      "SELECT text FROM chunks WHERE version_id = ? AND seq = ?",
    );
    for (const hit of top) {
      hit.text = String(textStmt.get(hit.versionId, hit.seq)!.text);
    }
    return top;
  }

  close(): void {
    this.db.close();
  }
}
