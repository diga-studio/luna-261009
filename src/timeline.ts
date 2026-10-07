import { Directive, DisciplineState } from "./types.js";

const S_NONE = 0;
const S_REVIEW = 1;
const S_PUNISH = 2;
const S_RESOLVED = 3;

const INF = 1_000_000_000;

/** 自动降级：处分中且覆盖归零时回到审查中，其余状态不变。 */
const AUTO: readonly number[] = [S_NONE, S_REVIEW, S_REVIEW, S_RESOLVED];
const IDENTITY: readonly number[] = [0, 1, 2, 3];

/** 人工指令对应的状态映射（满足前提才跳转，否则恒等）。 */
function directiveFn(target: DisciplineState, punishEnabled: boolean): readonly number[] {
  switch (target) {
    case DisciplineState.Review: // 无处分 -> 审查中
      return [S_REVIEW, S_REVIEW, S_PUNISH, S_RESOLVED];
    case DisciplineState.Punishment: // 审查中 -> 处分中，要求覆盖 >= 1
      return punishEnabled ? [S_NONE, S_PUNISH, S_PUNISH, S_RESOLVED] : IDENTITY;
    case DisciplineState.Resolved: // 处分中 -> 已解决
      return [S_NONE, S_REVIEW, S_RESOLVED, S_RESOLVED];
    case DisciplineState.None: // 已解决 -> 无处分
      return [S_NONE, S_REVIEW, S_PUNISH, S_NONE];
  }
}

function upperBound(arr: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 时间轴段树。
 *
 * 把周期内所有事件点（处罚区间边界、指令时间、周期起点）压缩为叶子。
 * 每个叶子保存该秒的状态转移函数（4 个状态上的映射，含必要的自动降级
 * 与该秒全部人工指令），内部节点保存子区间转移函数的复合。
 *
 * 撤销处罚 = 对覆盖计数做区间减一；计数只减不增，每个叶子最多发生一次
 * "归零翻转"，翻转时把叶子函数切换为零覆盖版本并沿树上推。
 * 查询 = 前缀函数复合作用于初始状态（无处分）。
 */
export class Timeline {
  private readonly periodStart: number;
  private readonly periodEnd: number;
  private penaltyStarts: number[] = [];
  private penaltyEnds: number[] = [];
  private directives: Directive[] = [];

  private times: number[] = [];
  private m = 0;
  private mn!: Int32Array;
  private lz!: Int32Array;
  private fn!: Uint8Array; // 每个节点 4 字节：状态映射
  private leafZero!: Uint8Array; // 每个叶子的零覆盖函数（4 字节）
  private built = false;

  constructor(periodStart: number, periodEnd: number) {
    this.periodStart = periodStart;
    this.periodEnd = periodEnd;
  }

  addPenalty(start: number, end: number): void {
    this.penaltyStarts.push(start);
    this.penaltyEnds.push(end);
  }

  addDirective(directive: Directive): void {
    this.directives.push(directive);
  }

  build(): void {
    const timeSet = new Set<number>();
    timeSet.add(this.periodStart);
    for (const s of this.penaltyStarts) timeSet.add(s);
    for (const e of this.penaltyEnds) timeSet.add(e);
    for (const d of this.directives) timeSet.add(d.time);
    this.times = [...timeSet].sort((a, b) => a - b);
    const m = (this.m = this.times.length);

    // 初始覆盖计数：差分数组 + 前缀和
    const diff = new Int32Array(m + 1);
    for (let i = 0; i < this.penaltyStarts.length; i++) {
      diff[upperBound(this.times, this.penaltyStarts[i]!) - 1]! += 1;
      diff[upperBound(this.times, this.penaltyEnds[i]!) - 1]! -= 1;
    }
    const coverage = new Int32Array(m);
    let acc = 0;
    for (let i = 0; i < m; i++) {
      acc += diff[i]!;
      coverage[i] = acc;
    }

    // 每个叶子的两种函数：有覆盖 / 零覆盖
    const leafCovered = new Uint8Array(4 * m);
    this.leafZero = new Uint8Array(4 * m);
    for (let i = 0; i < m; i++) {
      leafCovered.set(IDENTITY, 4 * i);
      this.leafZero.set(AUTO, 4 * i);
    }
    const sorted = [...this.directives].sort((a, b) => a.time - b.time || a.seq - b.seq);
    for (const d of sorted) {
      const idx = upperBound(this.times, d.time) - 1;
      applyFn(leafCovered, idx, directiveFn(d.target, true));
      applyFn(this.leafZero, idx, directiveFn(d.target, false));
    }

    const size = 4 * m + 8;
    this.mn = new Int32Array(size);
    this.lz = new Int32Array(size);
    this.fn = new Uint8Array(4 * size);
    this.buildNode(1, 0, m - 1, coverage, leafCovered);
    this.built = true;

    // 释放构建期数据
    this.penaltyStarts = [];
    this.penaltyEnds = [];
    this.directives = [];
  }

  private buildNode(node: number, l: number, r: number, coverage: Int32Array, leafCovered: Uint8Array): void {
    if (l === r) {
      const c = coverage[l]!;
      if (c === 0) {
        this.mn[node] = INF; // 已处于零覆盖，不会再翻转
        this.fn.set(this.leafZero.subarray(4 * l, 4 * l + 4), 4 * node);
      } else {
        this.mn[node] = c;
        this.fn.set(leafCovered.subarray(4 * l, 4 * l + 4), 4 * node);
      }
      return;
    }
    const mid = (l + r) >>> 1;
    this.buildNode(2 * node, l, mid, coverage, leafCovered);
    this.buildNode(2 * node + 1, mid + 1, r, coverage, leafCovered);
    this.pull(node);
  }

  private pull(node: number): void {
    this.mn[node] = Math.min(this.mn[2 * node]!, this.mn[2 * node + 1]!);
    const f = this.fn;
    const o = 4 * node;
    const ol = 8 * node;
    const or_ = 8 * node + 4;
    for (let s = 0; s < 4; s++) f[o + s] = f[or_ + f[ol + s]!]!;
  }

  private push(node: number): void {
    const v = this.lz[node]!;
    if (v !== 0) {
      for (const c of [2 * node, 2 * node + 1]) {
        this.mn[c]! += v;
        this.lz[c]! += v;
      }
      this.lz[node] = 0;
    }
  }

  /** 撤销 [start, end) 的覆盖。 */
  removeCoverage(start: number, end: number): void {
    const lo = upperBound(this.times, start) - 1;
    const hi = upperBound(this.times, end) - 2; // 最后一个 < end 的事件点
    if (lo > hi) return;
    this.addRange(1, 0, this.m - 1, lo, hi, -1);
    // 计数只减不增，把新归零的叶子翻转为零覆盖函数
    for (;;) {
      if (this.rangeMin(1, 0, this.m - 1, lo, hi) > 0) break;
      this.flipLeftmostZero(1, 0, this.m - 1, lo, hi);
    }
  }

  private addRange(node: number, l: number, r: number, ql: number, qr: number, delta: number): void {
    if (ql <= l && r <= qr) {
      this.mn[node]! += delta;
      this.lz[node]! += delta;
      return;
    }
    this.push(node);
    const mid = (l + r) >>> 1;
    if (ql <= mid) this.addRange(2 * node, l, mid, ql, qr, delta);
    if (qr > mid) this.addRange(2 * node + 1, mid + 1, r, ql, qr, delta);
    this.mn[node] = Math.min(this.mn[2 * node]!, this.mn[2 * node + 1]!);
  }

  private rangeMin(node: number, l: number, r: number, ql: number, qr: number): number {
    if (ql <= l && r <= qr) return this.mn[node]!;
    this.push(node);
    const mid = (l + r) >>> 1;
    let res = INF;
    if (ql <= mid) res = Math.min(res, this.rangeMin(2 * node, l, mid, ql, qr));
    if (qr > mid) res = Math.min(res, this.rangeMin(2 * node + 1, mid + 1, r, ql, qr));
    return res;
  }

  /** 找到 [ql,qr] 内最左的未翻转零计数叶子并翻转。 */
  private flipLeftmostZero(node: number, l: number, r: number, ql: number, qr: number): void {
    if (l === r) {
      this.mn[node] = INF;
      this.fn.set(this.leafZero.subarray(4 * l, 4 * l + 4), 4 * node);
      return;
    }
    this.push(node);
    const mid = (l + r) >>> 1;
    if (ql <= mid && this.mn[2 * node]! <= 0) {
      this.flipLeftmostZero(2 * node, l, mid, ql, qr);
    } else {
      this.flipLeftmostZero(2 * node + 1, mid + 1, r, ql, qr);
    }
    this.pull(node);
  }

  /** 处理完 time 秒全部变化后的状态。 */
  query(time: number): DisciplineState {
    const idx = upperBound(this.times, time) - 1;
    if (idx < 0) return DisciplineState.None;
    const accFn = new Uint8Array(IDENTITY);
    this.collect(1, 0, this.m - 1, idx, accFn);
    return accFn[S_NONE] as DisciplineState;
  }

  private collect(node: number, l: number, r: number, qr: number, accFn: Uint8Array): void {
    if (r <= qr) {
      const o = 4 * node;
      const f = this.fn;
      for (let s = 0; s < 4; s++) accFn[s] = f[o + accFn[s]!]!;
      return;
    }
    const mid = (l + r) >>> 1;
    this.collect(2 * node, l, mid, qr, accFn);
    if (qr > mid) this.collect(2 * node + 1, mid + 1, r, qr, accFn);
  }
}

/** acc = acc ∘ next（先应用 acc，再应用 next） */
function applyFn(leaf: Uint8Array, idx: number, next: readonly number[]): void {
  const o = 4 * idx;
  for (let s = 0; s < 4; s++) leaf[o + s] = next[leaf[o + s]!]!;
}
