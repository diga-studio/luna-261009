import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, type ChunkInput, type SearchHit } from "../src/index.js";
import { mulberry32, makeChunk, makeVocab } from "./helpers.js";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kstore-"));
  return { dir, path: join(dir, "knowledge.db") };
}

/** 比较时忽略 versionId（两个库的版本编号不同）。 */
function stripVersion(hits: SearchHit[]): Omit<SearchHit, "versionId">[] {
  return hits.map(({ versionId, ...rest }) => rest);
}

test("多次回滚再提交后，结果与仅导入当前版本的新库一致", () => {
  const { dir, path } = tempDb();
  try {
    const rand = mulberry32(2024);
    const { vocab, weights } = makeVocab(1000, rand);
    const store = new KnowledgeStore(path);

    // 10 个知识库，每库 5 个文档，每文档提交 4 个版本
    const kbs: string[] = [];
    for (let k = 0; k < 10; k++) kbs.push(`kb${k}`);
    const versions = new Map<string, { id: number; chunks: ChunkInput[] }[]>();
    const currentId = new Map<string, number>();
    for (const kb of kbs) {
      for (let d = 0; d < 5; d++) {
        const key = `${kb}/doc${d}`;
        const list: { id: number; chunks: ChunkInput[] }[] = [];
        for (let v = 0; v < 4; v++) {
          const chunks: ChunkInput[] = [];
          for (let c = 0; c < 10; c++) chunks.push(makeChunk(rand, vocab, weights, 30));
          list.push({ id: store.submitVersion(kb, `doc${d}`, chunks), chunks });
        }
        versions.set(key, list);
        currentId.set(key, list[list.length - 1].id);
      }
    }

    // 多次回滚：每个文档随机回滚到某个历史版本
    for (const [key, list] of versions) {
      const [kb, doc] = key.split("/");
      const target = list[Math.floor(rand() * list.length)];
      store.rollback(kb, doc, target.id);
      currentId.set(key, target.id);
    }
    // 部分文档回滚后再提交新版本
    const current = new Map<string, ChunkInput[]>();
    for (const [key, list] of versions) {
      const [kb, doc] = key.split("/");
      if (rand() < 0.5) {
        const chunks: ChunkInput[] = [];
        for (let c = 0; c < 10; c++) chunks.push(makeChunk(rand, vocab, weights, 30));
        currentId.set(key, store.submitVersion(kb, doc, chunks));
        current.set(key, chunks);
      } else {
        const cur = list.find((v) => v.id === currentId.get(key))!;
        current.set(key, cur.chunks);
      }
    }

    // 参照库：仅导入各文档当前版本
    const fresh = new KnowledgeStore(join(dir, "fresh.db"));
    for (const [key, chunks] of current) {
      const [kb, doc] = key.split("/");
      fresh.submitVersion(kb, doc, chunks);
    }

    const queries: string[][] = [];
    for (let i = 0; i < 20; i++) {
      const n = 1 + Math.floor(rand() * 4);
      const q: string[] = [];
      for (let j = 0; j < n; j++) q.push(vocab[Math.floor(rand() * vocab.length)]);
      queries.push(q);
    }
    for (const q of queries) {
      // 随机选择 1~10 个知识库
      const shuffled = [...kbs].sort(() => rand() - 0.5);
      const scope = shuffled.slice(0, 1 + Math.floor(rand() * 10));
      const actual = store.search(scope, q);
      const expected = fresh.search(scope, q);
      assert.deepEqual(stripVersion(actual), stripVersion(expected), `query=${q} scope=${scope}`);
      // 结果中的版本必须都是当前版本
      for (const hit of actual) {
        assert.equal(hit.versionId, currentId.get(`${hit.kbId}/${hit.docId}`));
      }
    }

    store.close();
    fresh.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
