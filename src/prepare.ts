import { FunnelEvent, STAGE_COUNT } from "./types";

/** 单个阶段的支配计数点集：A 点 (ax, ay) 与 B 点 (bx, by)，各自按 x 排序。 */
export interface StageIndex {
  ax: Uint32Array;
  ay: Uint32Array;
  bx: Uint32Array;
  by: Uint32Array;
}

/** 准备完成的内存结构，可序列化保存。 */
export interface PreparedFunnel {
  /** 去重排序后的全部事件时间（Float64，精确表示整数毫秒） */
  times: Float64Array;
  /** 每阶段点集 */
  stages: StageIndex[];
  /** 压缩时间秩的比特宽度 */
  timeBits: number;
}

const ACT_IMPRESSION = 0;
const ACT_CLICK = 1;
const ACT_CONVERSION = 2;

function actionCode(action: string): number {
  switch (action) {
    case "impression":
      return ACT_IMPRESSION;
    case "click":
      return ACT_CLICK;
    case "conversion":
      return ACT_CONVERSION;
    default:
      return 3;
  }
}

function lowerBoundF64(arr: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class Uint32Builder {
  private arr = new Uint32Array(1 << 16);
  private len = 0;

  push(v: number): void {
    if (this.len === this.arr.length) {
      const next = new Uint32Array(this.arr.length * 2);
      next.set(this.arr);
      this.arr = next;
    }
    this.arr[this.len++] = v;
  }

  build(): Uint32Array {
    return this.arr.slice(0, this.len);
  }
}

const RANK_BASE = 16777216; // 2^24，压缩时间秩必须小于该值

/**
 * 由原始事件构建准备数据。
 *
 * 核心思路：对每个客户、每个阶段，把该客户所有旅程中可能完成的链
 * （首事件时间 start，末事件时间 end）做帕累托前沿化简。窗口 [s,e)
 * 完成该阶段 ⟺ 前沿上第一个 start >= s 的点满足 end < e。
 * 再转化为矩形刺探计数：每客户每阶段的前沿点生成矩形
 * (prevStart, start] x (end, +inf)，同一客户的矩形在 s 轴上互不重叠，
 * 因此命中矩形数即去重客户数。矩形刺探 = 两组点的二维支配计数之差。
 */
export function prepare(events: Iterable<FunnelEvent>): PreparedFunnel {
  // 1. 读入事件到列式数组
  let n = 0;
  let cap = 1 << 16;
  let cust = new Uint32Array(cap);
  let jour = new Uint32Array(cap);
  let act = new Uint8Array(cap);
  let time = new Float64Array(cap);
  let seq = new Uint32Array(cap);
  const custMap = new Map<string, number>();
  const jourMap = new Map<string, number>();
  const jourCust: number[] = [];

  for (const e of events) {
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
      jourCust.push(ci);
    }
    cust[n] = ci;
    jour[n] = ji;
    act[n] = actionCode(e.action);
    time[n] = e.time;
    seq[n] = e.seq;
    n++;
  }

  // 2. 去重排序时间
  const ts = time.slice(0, n);
  ts.sort();
  let u = 0;
  const uniq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0 || ts[i] !== ts[i - 1]) uniq[u++] = ts[i];
  }
  const times = uniq.slice(0, u);

  // 3. 每个事件的时间秩（1 起始，0 留给 -inf）
  const trank = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    trank[i] = lowerBoundF64(times, u, time[i]) + 1;
  }
  if (u + 1 >= RANK_BASE) {
    throw new Error("too many distinct timestamps (>= 2^24)");
  }

  // 4. 按旅程计数排序，得到每个旅程的事件区间
  const journeyCount = jourMap.size;
  const cnt = new Uint32Array(journeyCount);
  for (let i = 0; i < n; i++) cnt[jour[i]]++;
  const off = new Uint32Array(journeyCount + 1);
  for (let j = 0; j < journeyCount; j++) off[j + 1] = off[j] + cnt[j];
  const pos = new Uint32Array(n);
  const cursor = Uint32Array.from(off.subarray(0, journeyCount));
  for (let i = 0; i < n; i++) pos[cursor[jour[i]]++] = i;

  // 5. 旅程按客户排序（客户 * 2^22 + 旅程，要求旅程数 < 2^22）
  if (journeyCount >= 4194304) {
    throw new Error("too many journeys (>= 2^22)");
  }
  const jkey = new Float64Array(journeyCount);
  for (let j = 0; j < journeyCount; j++) jkey[j] = jourCust[j] * 4194304 + j;
  jkey.sort();

  // 6. 按客户处理：收集链候选 -> 帕累托前沿 -> 矩形
  const xlB: Uint32Builder[] = [];
  const xrB: Uint32Builder[] = [];
  const yB: Uint32Builder[] = [];
  for (let s = 0; s < STAGE_COUNT; s++) {
    xlB.push(new Uint32Builder());
    xrB.push(new Uint32Builder());
    yB.push(new Uint32Builder());
  }
  const candS: number[][] = [[], [], [], []];
  const candE: number[][] = [[], [], [], []];
  const frontierS: number[] = [];
  const frontierE: number[] = [];

  let tr = new Uint32Array(0);
  let sq = new Uint32Array(0);
  let ac = new Uint8Array(0);
  let idx = new Uint32Array(0);

  let ji = 0;
  while (ji < journeyCount) {
    const customerOfJourney = Math.floor(jkey[ji] / 4194304);
    for (let s = 0; s < STAGE_COUNT; s++) {
      candS[s].length = 0;
      candE[s].length = 0;
    }
    // 处理该客户的全部旅程
    while (ji < journeyCount && Math.floor(jkey[ji] / 4194304) === customerOfJourney) {
      const j = jkey[ji] % 4194304;
      ji++;
      const begin = off[j];
      const end = off[j + 1];
      const len = end - begin;
      if (len === 0) continue;
      if (len > idx.length) {
        let newSize = idx.length || 16;
        while (newSize < len) newSize *= 2;
        idx = new Uint32Array(newSize);
        tr = new Uint32Array(newSize);
        sq = new Uint32Array(newSize);
        ac = new Uint8Array(newSize);
      }
      // 旅程内按 (时间秩, 序号, 原始下标) 排序
      for (let i = 0; i < len; i++) {
        const ev = pos[begin + i];
        idx[i] = ev;
        tr[i] = trank[ev];
        sq[i] = seq[ev];
        ac[i] = act[ev];
      }
      const order = idx.subarray(0, len);
      order.sort((a, b) => trank[a] - trank[b] || seq[a] - seq[b] || a - b);
      for (let i = 0; i < len; i++) {
        const ev = order[i];
        tr[i] = trank[ev];
        sq[i] = seq[ev];
        ac[i] = act[ev];
      }
      // next 指针：严格靠后的下一个 click / conversion 的局部下标
      const nextClick = new Int32Array(len);
      const nextConv = new Int32Array(len);
      let nc = -1;
      let nv = -1;
      for (let i = len - 1; i >= 0; i--) {
        nextClick[i] = nc;
        nextConv[i] = nv;
        if (ac[i] === ACT_CLICK) nc = i;
        else if (ac[i] === ACT_CONVERSION) nv = i;
      }
      // 每个 impression 贪心生成各阶段链
      for (let i = 0; i < len; i++) {
        if (ac[i] !== ACT_IMPRESSION) continue;
        const s1 = tr[i];
        candS[0].push(s1);
        candE[0].push(s1);
        const i2 = nextClick[i];
        if (i2 < 0) continue;
        candS[1].push(s1);
        candE[1].push(tr[i2]);
        const i3 = nextClick[i2];
        if (i3 < 0) continue;
        candS[2].push(s1);
        candE[2].push(tr[i3]);
        const i4 = nextConv[i3];
        if (i4 < 0) continue;
        candS[3].push(s1);
        candE[3].push(tr[i4]);
      }
    }

    // 对该客户每个阶段做帕累托前沿并输出矩形
    for (let st = 0; st < STAGE_COUNT; st++) {
      const m = candS[st].length;
      if (m === 0) continue;
      const key = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        key[i] = candS[st][i] * RANK_BASE + candE[st][i];
      }
      key.sort();
      frontierS.length = 0;
      frontierE.length = 0;
      let minEnd = Infinity;
      let i = m - 1;
      while (i >= 0) {
        const s = Math.floor(key[i] / RANK_BASE);
        let j = i;
        while (j - 1 >= 0 && Math.floor(key[j - 1] / RANK_BASE) === s) j--;
        const emin = key[j] % RANK_BASE;
        if (emin < minEnd) {
          minEnd = emin;
          frontierS.push(s);
          frontierE.push(emin);
        }
        i = j - 1;
      }
      let prev = 0;
      for (let t = frontierS.length - 1; t >= 0; t--) {
        xlB[st].push(prev);
        xrB[st].push(frontierS[t]);
        yB[st].push(frontierE[t]);
        prev = frontierS[t];
      }
    }
  }

  // 7. 每阶段把矩形拆成 A/B 两组点并按 x 排序
  const stages: StageIndex[] = [];
  for (let st = 0; st < STAGE_COUNT; st++) {
    const xl = xlB[st].build();
    const xr = xrB[st].build();
    const y = yB[st].build();
    const m = y.length;
    const ka = new Float64Array(m);
    for (let i = 0; i < m; i++) ka[i] = xl[i] * RANK_BASE + y[i];
    ka.sort();
    const ax = new Uint32Array(m);
    const ay = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      ax[i] = Math.floor(ka[i] / RANK_BASE);
      ay[i] = ka[i] % RANK_BASE;
    }
    const kb = new Float64Array(m);
    for (let i = 0; i < m; i++) kb[i] = xr[i] * RANK_BASE + y[i];
    kb.sort();
    const bx = new Uint32Array(m);
    const by = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      bx[i] = Math.floor(kb[i] / RANK_BASE);
      by[i] = kb[i] % RANK_BASE;
    }
    stages.push({ ax, ay, bx, by });
  }

  let timeBits = 1;
  while ((1 << timeBits) <= u) timeBits++;

  return { times, stages, timeBits };
}
