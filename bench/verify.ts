import * as fs from "fs";
import { genEvents, mulberry32, BENCH } from "./gen";
import { genWindows } from "./windows";
import { STAGE_COUNT } from "../src/types";

const ACT = new Map<string, number>([
  ["impression", 0],
  ["click", 1],
  ["conversion", 2],
]);

/** 全量数据上的独立暴力计算：逐旅程扫描窗口内事件，贪心匹配。 */
export class BruteForce {
  private journeyCust: Uint32Array;
  private off: Uint32Array;
  private evTime: Float64Array;
  private evAct: Uint8Array;
  private evSeq: Uint32Array;
  readonly customerCount: number;

  constructor() {
    const custMap = new Map<string, number>();
    const jourMap = new Map<string, number>();
    let n = 0;
    let cap = 1 << 20;
    let cust = new Uint32Array(cap);
    let jour = new Uint32Array(cap);
    let act = new Uint8Array(cap);
    let time = new Float64Array(cap);
    let seq = new Uint32Array(cap);
    const jourCustArr: number[] = [];
    for (const e of genEvents()) {
      if (n === cap) {
        cap *= 2;
        const nc = new Uint32Array(cap);
        nc.set(cust);
        cust = nc;
        const nj = new Uint32Array(cap);
        nj.set(jour);
        jour = nj;
        const na = new Uint8Array(cap);
        na.set(act);
        act = na;
        const nt = new Float64Array(cap);
        nt.set(time);
        time = nt;
        const ns = new Uint32Array(cap);
        ns.set(seq);
        seq = ns;
      }
      let ci = custMap.get(e.customer);
      if (ci === undefined) {
        ci = custMap.size;
        custMap.set(e.customer, ci);
      }
      let ji = jourMap.get(e.journey);
      if (ji === undefined) {
        ji = jourMap.size;
        jourMap.set(e.journey, ji);
        jourCustArr.push(ci);
      }
      cust[n] = ci;
      jour[n] = ji;
      act[n] = ACT.get(e.action) ?? 3;
      time[n] = e.time;
      seq[n] = e.seq;
      n++;
    }
    this.customerCount = custMap.size;

    // 按旅程分桶（计数排序），桶内按 (time, seq) 排序
    const J = jourMap.size;
    const cnt = new Uint32Array(J);
    for (let i = 0; i < n; i++) cnt[jour[i]]++;
    const off = new Uint32Array(J + 1);
    for (let j = 0; j < J; j++) off[j + 1] = off[j] + cnt[j];
    const pos = new Uint32Array(n);
    const cursor = Uint32Array.from(off.subarray(0, J));
    for (let i = 0; i < n; i++) pos[cursor[jour[i]]++] = i;

    this.evTime = new Float64Array(n);
    this.evAct = new Uint8Array(n);
    this.evSeq = new Uint32Array(n);
    this.journeyCust = new Uint32Array(J);
    for (let j = 0; j < J; j++) this.journeyCust[j] = jourCustArr[j];
    // 桶内排序：先拷贝 (time, seq, act)，用子数组比较器排序位置
    for (let j = 0; j < J; j++) {
      const begin = off[j];
      const len = off[j + 1] - begin;
      if (len === 0) continue;
      const slice = pos.subarray(begin, begin + len);
      slice.sort((a, b) => time[a] - time[b] || seq[a] - seq[b]);
      for (let i = 0; i < len; i++) {
        const ev = pos[begin + i];
        this.evTime[begin + i] = time[ev];
        this.evAct[begin + i] = act[ev];
        this.evSeq[begin + i] = seq[ev];
      }
    }
    this.off = off;
  }

  query(startMs: number, endMs: number): [number, number, number, number] {
    const done: Uint8Array[] = [];
    for (let s = 0; s < STAGE_COUNT; s++) {
      done.push(new Uint8Array(this.customerCount));
    }
    const J = this.journeyCust.length;
    for (let j = 0; j < J; j++) {
      const begin = this.off[j];
      const end = this.off[j + 1];
      let stage = 0;
      for (let i = begin; i < end && stage < STAGE_COUNT; i++) {
        const t = this.evTime[i];
        if (t < startMs) continue;
        if (t >= endMs) break;
        if (this.evAct[i] === actOfStage(stage)) {
          done[stage][this.journeyCust[j]] = 1;
          stage++;
        }
      }
    }
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let s = 0; s < STAGE_COUNT; s++) {
      let c = 0;
      const d = done[s];
      for (let i = 0; i < d.length; i++) c += d[i];
      out[s] = c;
    }
    return out;
  }
}

function actOfStage(stage: number): number {
  // 阶段动作：impression(0) click(1) click(1) conversion(2)
  return stage === 0 ? 0 : stage === 3 ? 2 : 1;
}

/** 抽样校验：结果文件中的计数与暴力计算一致。 */
export function verifySamples(resultsFile: string, sampleCount: number): void {
  const { queries } = genWindows();
  const results = new Uint32Array(fs.readFileSync(resultsFile).buffer.slice(0));
  const rng = mulberry32(BENCH.seed + 2);
  const indices = new Set<number>();
  while (indices.size < sampleCount) {
    indices.add(Math.floor(rng() * queries.length));
  }
  const brute = new BruteForce();
  let checked = 0;
  for (const idx of indices) {
    const w = queries[idx];
    const want = brute.query(w.start, w.end);
    const got = [
      results[idx * 4],
      results[idx * 4 + 1],
      results[idx * 4 + 2],
      results[idx * 4 + 3],
    ];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(
        `sample ${idx} window [${w.start}, ${w.end}): got ${got}, want ${want}`,
      );
    }
    checked++;
  }
  console.log(`sample verification passed: ${checked} windows match brute force`);
}

/** 两次独立进程的结果完全一致。 */
export function compareResults(fileA: string, fileB: string): void {
  const a = fs.readFileSync(fileA);
  const b = fs.readFileSync(fileB);
  if (a.length !== b.length) throw new Error("result files differ in size");
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) {
      throw new Error(`results differ at index ${i}: ${ua[i]} vs ${ub[i]}`);
    }
  }
  console.log(`reopen consistency passed: ${ua.length / 4} queries identical`);
}

/** 宽窗口阶段计数必须存在真实变化。 */
export function checkVariation(resultsFile: string): void {
  const results = new Uint32Array(fs.readFileSync(resultsFile).buffer.slice(0));
  const wide = 8000; // 前 8000 个为宽窗口
  const mins = [Infinity, Infinity, Infinity, Infinity];
  const maxs = [0, 0, 0, 0];
  for (let i = 0; i < wide; i++) {
    for (let s = 0; s < 4; s++) {
      const v = results[i * 4 + s];
      if (v < mins[s]) mins[s] = v;
      if (v > maxs[s]) maxs[s] = v;
    }
  }
  const threshold = Math.max(50, Math.floor(BENCH.customerCount / 100));
  console.log("wide-window stage count ranges:");
  for (let s = 0; s < 4; s++) {
    console.log(`  stage ${s + 1}: ${mins[s]} .. ${maxs[s]}`);
    if (maxs[s] - mins[s] < threshold) {
      throw new Error(`stage ${s + 1} counts show no real variation`);
    }
  }
}
