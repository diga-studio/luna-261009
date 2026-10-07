import type { ChunkInput, SearchHit } from "../src/index.js";

/** 参考模型中的一个活跃块。 */
export interface RefChunk {
  kbId: string;
  docId: string;
  versionId: number;
  seq: number;
  text: string;
  terms: string[];
}

/**
 * 独立的全量 BM25 参考实现：直接对活跃块列表按固定口径计算。
 * 与被测实现保持完全相同的浮点运算顺序。
 */
export function referenceSearch(active: RefChunk[], queryTerms: string[]): SearchHit[] {
  const terms = [...new Set(queryTerms)].sort();
  const N = active.length;
  if (N === 0 || terms.length === 0) return [];
  let totalLen = 0;
  for (const c of active) totalLen += c.terms.length;
  const avgL = totalLen / N;

  const hits: SearchHit[] = [];
  for (const c of active) {
    const tf = new Map<string, number>();
    for (const t of c.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const count = tf.get(term);
      if (count === undefined) continue;
      let df = 0;
      for (const other of active) {
        if (other.terms.includes(term)) df++;
      }
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const L = c.terms.length;
      score += (idf * count * 2.2) / (count + 1.2 * (0.25 + (0.75 * L) / avgL));
    }
    if (score > 0) {
      hits.push({
        kbId: c.kbId,
        docId: c.docId,
        versionId: c.versionId,
        seq: c.seq,
        text: c.text,
        score,
      });
    }
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.kbId < b.kbId ? -1 : a.kbId > b.kbId ? 1 : 0) ||
      (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0) ||
      a.seq - b.seq,
  );
  return hits.slice(0, 5);
}

/** 确定性 PRNG（mulberry32），保证规模用例可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一个块：从词表中按权重抽取 n 个词项（保留重复）。 */
export function makeChunk(
  rand: () => number,
  vocab: string[],
  weights: number[],
  n: number,
  text?: string,
): ChunkInput {
  const terms: string[] = [];
  for (let i = 0; i < n; i++) {
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
  return { text: text ?? terms.join(" "), terms };
}

/** 构造 Zipf 风格累计权重表，头部词可覆盖 50% 以上的块。 */
export function makeVocab(size: number, rand: () => number): { vocab: string[]; weights: number[] } {
  const vocab: string[] = [];
  const weights: number[] = [];
  let acc = 0;
  for (let i = 0; i < size; i++) {
    vocab.push(`w${i}`);
    acc += 1 / (i + 1);
    weights.push(acc);
  }
  for (let i = 0; i < size; i++) weights[i] /= acc;
  return { vocab, weights };
}
