import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/index.js";
import {
  mulberry32,
  makeChunk,
  makeVocab,
  referenceSearch,
  type RefChunk,
} from "./helpers.js";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kstore-"));
  return { dir, path: join(dir, "knowledge.db") };
}

test("高频词 + 多词查询：前 5 名与分数和独立全量计算一致", () => {
  const { dir, path } = tempDb();
  try {
    const rand = mulberry32(555);
    const { vocab, weights } = makeVocab(500, rand);
    const store = new KnowledgeStore(path);
    const active: RefChunk[] = [];

    // 3 个知识库，每库 4 个文档，每文档 25 块，每块 40 词
    // w0 权重最高，出现在 50% 以上的块中
    for (let k = 0; k < 3; k++) {
      for (let d = 0; d < 4; d++) {
        const chunks = [];
        for (let c = 0; c < 25; c++) chunks.push(makeChunk(rand, vocab, weights, 40));
        const versionId = store.submitVersion(`kb${k}`, `doc${d}`, chunks);
        chunks.forEach((chunk, seq) =>
          active.push({
            kbId: `kb${k}`,
            docId: `doc${d}`,
            versionId,
            seq,
            text: chunk.text,
            terms: chunk.terms,
          }),
        );
      }
    }
    // 验证高频词覆盖率 > 50%
    const cover = active.filter((c) => c.terms.includes("w0")).length;
    assert.ok(cover > active.length / 2, `w0 覆盖率 ${cover}/${active.length}`);

    const scopeAll = ["kb0", "kb1", "kb2"];
    const queries = [
      ["w0"], // 单个高频词
      ["w0", "w1", "w2"], // 多个高频词
      ["w0", "w250", "w499"], // 高频 + 低频混合
      ["w499"], // 低频词
    ];
    for (const q of queries) {
      const expected = referenceSearch(active, q);
      const actual = store.search(scopeAll, q);
      assert.deepEqual(actual, expected, `query=${q}`);
      assert.ok(actual.length > 0);
    }
    // 子范围：只查部分知识库
    const sub = referenceSearch(active.filter((c) => c.kbId !== "kb2"), ["w0", "w7"]);
    assert.deepEqual(store.search(["kb0", "kb1"], ["w0", "w7"]), sub);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同分边界：得分相同按知识库、文档字典序再按块序号升序", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    // 7 个完全相同的块（同分），分布在不同知识库/文档/块序号
    const mk = () => ({ text: "same content", terms: ["x", "y"] });
    store.submitVersion("kb-b", "doc2", [mk(), mk()]); // seq 0,1
    store.submitVersion("kb-a", "doc2", [mk()]);
    store.submitVersion("kb-a", "doc1", [mk(), mk(), mk()]); // seq 0,1,2
    const hits = store.search(["kb-a", "kb-b"], ["x"]);
    assert.equal(hits.length, 5); // 7 个同分块只取前 5
    const order = hits.map((h) => `${h.kbId}/${h.docId}#${h.seq}`);
    assert.deepEqual(order, [
      "kb-a/doc1#0",
      "kb-a/doc1#1",
      "kb-a/doc1#2",
      "kb-a/doc2#0",
      "kb-b/doc2#0",
    ]);
    // 分数确实相同
    assert.ok(hits.every((h) => h.score === hits[0].score));

    // 与参考实现对照（同分排序一致）
    const active: RefChunk[] = [
      { kbId: "kb-b", docId: "doc2", versionId: 1, seq: 0, text: "same content", terms: ["x", "y"] },
      { kbId: "kb-b", docId: "doc2", versionId: 1, seq: 1, text: "same content", terms: ["x", "y"] },
      { kbId: "kb-a", docId: "doc2", versionId: 2, seq: 0, text: "same content", terms: ["x", "y"] },
      { kbId: "kb-a", docId: "doc1", versionId: 3, seq: 0, text: "same content", terms: ["x", "y"] },
      { kbId: "kb-a", docId: "doc1", versionId: 3, seq: 1, text: "same content", terms: ["x", "y"] },
      { kbId: "kb-a", docId: "doc1", versionId: 3, seq: 2, text: "same content", terms: ["x", "y"] },
    ];
    assert.deepEqual(store.search(["kb-a", "kb-b"], ["x", "y"]), referenceSearch(active, ["x", "y"]));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无词项块长度为 0，仍计入 N 与平均长度", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    const versionId = store.submitVersion("kb", "doc", [
      { text: "hit", terms: ["target"] },
      { text: "empty1", terms: [] },
      { text: "empty2", terms: [] },
    ]);
    const active: RefChunk[] = [
      { kbId: "kb", docId: "doc", versionId, seq: 0, text: "hit", terms: ["target"] },
      { kbId: "kb", docId: "doc", versionId, seq: 1, text: "empty1", terms: [] },
      { kbId: "kb", docId: "doc", versionId, seq: 2, text: "empty2", terms: [] },
    ];
    const expected = referenceSearch(active, ["target"]);
    const actual = store.search(["kb"], ["target"]);
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
