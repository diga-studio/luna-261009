import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, type ChunkInput } from "../src/index.js";
import { mulberry32, makeChunk, makeVocab } from "./helpers.js";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kstore-"));
  return { dir, path: join(dir, "knowledge.db") };
}

function seedKb(
  store: KnowledgeStore,
  kbId: string,
  docs: number,
  chunksPerDoc: number,
  rand: () => number,
  vocab: string[],
  weights: number[],
): void {
  for (let d = 0; d < docs; d++) {
    const chunks: ChunkInput[] = [];
    for (let c = 0; c < chunksPerDoc; c++) {
      chunks.push(makeChunk(rand, vocab, weights, 40));
    }
    store.submitVersion(kbId, `${kbId}-doc${d}`, chunks);
  }
}

test("加入大量未绑定内容和历史版本后，原查询排名与分数完全不变", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    const rand = mulberry32(7);
    const { vocab, weights } = makeVocab(2000, rand);

    // 绑定范围 kb-a、kb-b，内容显式保存，记录 v1 版本号
    const docContents = new Map<string, ChunkInput[]>();
    const v1ids = new Map<string, number>();
    for (const kb of ["kb-a", "kb-b"]) {
      for (let d = 0; d < 10; d++) {
        const chunks: ChunkInput[] = [];
        for (let c = 0; c < 20; c++) chunks.push(makeChunk(rand, vocab, weights, 40));
        const key = `${kb}/doc${d}`;
        v1ids.set(key, store.submitVersion(kb, `doc${d}`, chunks));
        docContents.set(key, chunks);
      }
    }

    // 从实际内容中挑选查询词，保证有命中
    const allTerms = [...docContents.values()].flat().flatMap((c) => c.terms);
    const freq = new Map<string, number>();
    for (const t of allTerms) freq.set(t, (freq.get(t) ?? 0) + 1);
    const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const queries = [
      [byFreq[0][0]], // 最高频词
      [byFreq[10][0], byFreq[50][0]],
      [byFreq[100][0], byFreq[500][0], byFreq[byFreq.length - 1][0]],
    ];
    const baseline = queries.map((q) => store.search(["kb-a", "kb-b"], q));
    assert.ok(baseline.every((r) => r.length > 0), "基线应有命中");

    // 1) 加入大量未绑定知识库（同一词表，含相同高频词）
    for (let k = 0; k < 30; k++) {
      seedKb(store, `kb-unbound-${k}`, 10, 20, rand, vocab, weights);
    }
    // 2) 为每个绑定文档制造历史版本：提交两个干扰版本，再回滚到 v1
    for (const key of docContents.keys()) {
      const [kb, doc] = key.split("/");
      for (let v = 0; v < 2; v++) {
        const noise: ChunkInput[] = [];
        for (let c = 0; c < 20; c++) noise.push(makeChunk(rand, vocab, weights, 40));
        store.submitVersion(kb, doc, noise);
      }
      store.rollback(kb, doc, v1ids.get(key)!);
    }

    const after = queries.map((q) => store.search(["kb-a", "kb-b"], q));
    assert.deepEqual(after, baseline);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("历史版本（非当前）不出现在结果中", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    const v1 = store.submitVersion("kb", "doc", [
      { text: "old-content", terms: ["target"] },
    ]);
    store.submitVersion("kb", "doc", [{ text: "new-content", terms: ["other"] }]);
    assert.equal(store.search(["kb"], ["target"]).length, 0);
    store.rollback("kb", "doc", v1);
    const hits = store.search(["kb"], ["target"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].versionId, v1);
    assert.equal(hits[0].text, "old-content");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
