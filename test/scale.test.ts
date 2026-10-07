import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, type ChunkInput } from "../src/index.js";
import { mulberry32, makeVocab } from "./helpers.js";

// 规模参数（可用环境变量缩小以便快速冒烟）
const NUM_KBS = Number(process.env.SCALE_KBS ?? 100);
const DOCS_PER_KB = Number(process.env.SCALE_DOCS ?? 20);
const CHUNKS_PER_DOC = Number(process.env.SCALE_CHUNKS ?? 100);
const HISTORY_VERSIONS = Number(process.env.SCALE_HISTORY ?? 3);
const TERMS_PER_CHUNK = 40;
const VOCAB_SIZE = 5000;
const NUM_QUERIES = Number(process.env.SCALE_QUERIES ?? 100);

function makeChunkFast(rand: () => number, vocab: string[], weights: number[]): ChunkInput {
  const terms: string[] = [];
  for (let i = 0; i < TERMS_PER_CHUNK; i++) {
    const r = rand();
    let lo = 0;
    let hi = weights.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weights[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    terms.push(vocab[lo]);
  }
  return { text: terms.join(" "), terms };
}

test(
  `规模用例：${NUM_KBS} 知识库 / ${NUM_KBS * DOCS_PER_KB * CHUNKS_PER_DOC} 活跃块 / ` +
    `${NUM_KBS * DOCS_PER_KB * CHUNKS_PER_DOC * HISTORY_VERSIONS} 历史块`,
  { timeout: 600000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "kstore-scale-"));
    try {
      let peakRssDuringLoad = process.memoryUsage().rss;
      const rand = mulberry32(20261009);
      const { vocab, weights } = makeVocab(VOCAB_SIZE, rand);
      const store = new KnowledgeStore(join(dir, "scale.db"));

      // 每个文档提交 1+HISTORY_VERSIONS 个版本，最后版本为当前版本
      const t0 = Date.now();
      for (let k = 0; k < NUM_KBS; k++) {
        for (let d = 0; d < DOCS_PER_KB; d++) {
          for (let v = 0; v <= HISTORY_VERSIONS; v++) {
            const chunks: ChunkInput[] = [];
            for (let c = 0; c < CHUNKS_PER_DOC; c++) {
              chunks.push(makeChunkFast(rand, vocab, weights));
            }
            store.submitVersion(`kb${k}`, `doc${d}`, chunks);
          }
        }
        const rssNow = process.memoryUsage().rss;
        if (rssNow > peakRssDuringLoad) peakRssDuringLoad = rssNow;
      }
      const loadMs = Date.now() - t0;

      // 100 条不同查询：范围 10 个知识库（覆盖最大允许范围），1~5 个词项
      const queries: { kbs: string[]; terms: string[] }[] = [];
      for (let i = 0; i < NUM_QUERIES; i++) {
        const kbs = new Set<string>();
        while (kbs.size < Math.min(10, NUM_KBS)) {
          kbs.add(`kb${Math.floor(rand() * NUM_KBS)}`);
        }
        const nTerms = 1 + Math.floor(rand() * 5);
        const terms = new Set<string>();
        while (terms.size < nTerms) {
          // 偏向高频词，模拟真实查询分布
          const idx = Math.floor(Math.pow(rand(), 2) * VOCAB_SIZE);
          terms.add(vocab[idx]);
        }
        queries.push({ kbs: [...kbs], terms: [...terms] });
      }

      const latencies: number[] = [];
      let peakRss = peakRssDuringLoad;
      let totalHits = 0;
      for (const q of queries) {
        const start = performance.now();
        const hits = store.search(q.kbs, q.terms);
        latencies.push(performance.now() - start);
        totalHits += hits.length;
        const rss = process.memoryUsage().rss;
        if (rss > peakRss) peakRss = rss;
      }
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const max = latencies[latencies.length - 1];
      const peakMiB = peakRss / 1024 / 1024;

      console.log(
        `[scale] 加载 ${NUM_KBS * DOCS_PER_KB * (HISTORY_VERSIONS + 1)} 个版本耗时 ${(loadMs / 1000).toFixed(1)}s\n` +
          `[scale] 查询 ${NUM_QUERIES} 条：p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms\n` +
          `[scale] 峰值内存 rss=${peakMiB.toFixed(0)} MiB，总命中块数=${totalHits}`,
      );

      assert.ok(totalHits > 0, "规模用例应有命中");
      assert.ok(p95 <= 200, `查询 p95 ${p95.toFixed(1)}ms 超过 200ms`);
      assert.ok(peakMiB <= 256, `峰值内存 ${peakMiB.toFixed(0)} MiB 超过 256 MiB`);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
