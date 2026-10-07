/** 每毫秒对应的小时数换算。 */
const MS_PER_HOUR = 3_600_000;

/**
 * 有序时间线：按毫秒时间戳保存遥测，支持同时间戳覆盖更正、
 * 任意时刻累计运行小时查询、任意窗口内的最小二乘聚合量查询。
 *
 * 内部使用带父指针的随机 treap。每个节点保存：
 * - delta：从本节点时间戳到后继节点时间戳之间、由本节点转速决定的运行小时
 *   （停机为 0，无后继为 0，最后记录之后的延拓在查询时按部分区间处理）。
 * - 子树聚合：以“进入该子树时已累计的运行小时”为未知量 H_in，
 *   各拟合点横坐标 = H_in + offset，聚合量按 offset 的函数存储，
 *   合并时只需 O(1) 平移，因此历史更正只影响 O(log n) 个节点。
 */
export interface WindowSums {
  /** 窗口内参与拟合的点数（运行中的记录）。 */
  readonly count: number;
  readonly sumY: number;
  readonly sumX: number;
  readonly sumXY: number;
  readonly sumXX: number;
}

interface SubtreeAgg {
  cnt: number;
  sy: number;
  so: number;
  soy: number;
  so2: number;
  hours: number;
}

class Node {
  left: Node | null = null;
  right: Node | null = null;
  parent: Node | null = null;
  readonly priority = Math.random();
  delta = 0;
  minTs: number;
  maxTs: number;
  cnt = 0;
  sy = 0;
  so = 0;
  soy = 0;
  so2 = 0;
  hours = 0;

  constructor(
    readonly ts: number,
    public running: boolean,
    public y: number,
  ) {
    this.minTs = ts;
    this.maxTs = ts;
  }
}

function zeroAgg(): SubtreeAgg {
  return { cnt: 0, sy: 0, so: 0, soy: 0, so2: 0, hours: 0 };
}

export class Timeline {
  private root: Node | null = null;
  private readonly byTs = new Map<number, Node>();
  private readonly aggCache = new WeakMap<Node, SubtreeAgg>();

  get size(): number {
    return this.byTs.size;
  }

  /** 写入或更正一条记录；running 表示转速 > 0，y 为归一化扬程。 */
  upsert(timestampMs: number, running: boolean, y: number): void {
    const existing = this.byTs.get(timestampMs);
    if (existing !== undefined) {
      existing.running = running;
      existing.y = y;
      this.refreshDelta(existing);
      this.touch(existing);
      return;
    }
    const node = new Node(timestampMs, running, y);
    this.byTs.set(timestampMs, node);
    this.insertLeaf(node);
    this.refreshDelta(node);
    const pred = this.predecessor(node);
    if (pred !== null) {
      this.refreshDelta(pred);
    }
    this.rotateUp(node);
    this.touch(node);
    if (pred !== null) {
      this.touch(pred);
    }
  }

  /** 从最早记录之前（视为停机）到时刻 t 累计的运行小时。 */
  runningHoursAt(t: number): number {
    const pred = this.floor(t);
    if (pred === null) {
      return 0;
    }
    const before = this.prefixHoursBefore(pred);
    const partial = pred.running ? (t - pred.ts) / MS_PER_HOUR : 0;
    return before + partial;
  }

  /**
   * 窗口 [leftMs, rightMs]（两端包含）内拟合点的聚合量，
   * 横坐标为窗口左端起算的累计运行小时。
   */
  windowSums(leftMs: number, rightMs: number): WindowSums {
    const pieces: SubtreeAgg[] = [];
    this.collectRange(this.root, leftMs, rightMs, pieces);
    const first = this.lowerBound(leftMs);
    const base =
      first !== null && first.ts <= rightMs
        ? this.prefixHoursBefore(first) - this.runningHoursAt(leftMs)
        : 0;
    const acc = zeroAgg();
    acc.hours = base;
    for (const piece of pieces) {
      const h = acc.hours;
      acc.so += piece.so + piece.cnt * h;
      acc.soy += piece.soy + piece.sy * h;
      acc.so2 += piece.so2 + 2 * h * piece.so + piece.cnt * h * h;
      acc.cnt += piece.cnt;
      acc.sy += piece.sy;
      acc.hours += piece.hours;
    }
    return {
      count: acc.cnt,
      sumY: acc.sy,
      sumX: acc.so,
      sumXY: acc.soy,
      sumXX: acc.so2,
    };
  }

  private aggOf(node: Node): SubtreeAgg {
    let agg = this.aggCache.get(node);
    if (agg === undefined) {
      agg = zeroAgg();
      this.aggCache.set(node, agg);
    }
    return agg;
  }

  private recalc(node: Node): void {
    const l = node.left;
    const r = node.right;
    node.minTs = l !== null ? l.minTs : node.ts;
    node.maxTs = r !== null ? r.maxTs : node.ts;
    const offV = l !== null ? l.hours : 0;
    const baseR = offV + node.delta;
    const run = node.running ? 1 : 0;
    node.cnt = (l?.cnt ?? 0) + run + (r?.cnt ?? 0);
    node.sy = (l?.sy ?? 0) + run * node.y + (r?.sy ?? 0);
    node.so =
      (l?.so ?? 0) + run * offV + (r !== null ? r.so + r.cnt * baseR : 0);
    node.soy =
      (l?.soy ?? 0) +
      run * offV * node.y +
      (r !== null ? r.soy + r.sy * baseR : 0);
    node.so2 =
      (l?.so2 ?? 0) +
      run * offV * offV +
      (r !== null ? r.so2 + 2 * baseR * r.so + r.cnt * baseR * baseR : 0);
    node.hours = offV + node.delta + (r?.hours ?? 0);
  }

  private touch(node: Node | null): void {
    let cur = node;
    while (cur !== null) {
      this.recalc(cur);
      cur = cur.parent;
    }
  }

  private successor(node: Node): Node | null {
    if (node.right !== null) {
      let cur = node.right;
      while (cur.left !== null) {
        cur = cur.left;
      }
      return cur;
    }
    let cur = node;
    let p = cur.parent;
    while (p !== null && p.right === cur) {
      cur = p;
      p = p.parent;
    }
    return p;
  }

  private predecessor(node: Node): Node | null {
    if (node.left !== null) {
      let cur = node.left;
      while (cur.right !== null) {
        cur = cur.right;
      }
      return cur;
    }
    let cur = node;
    let p = cur.parent;
    while (p !== null && p.left === cur) {
      cur = p;
      p = p.parent;
    }
    return p;
  }

  private refreshDelta(node: Node): void {
    const succ = this.successor(node);
    node.delta =
      succ !== null && node.running ? (succ.ts - node.ts) / MS_PER_HOUR : 0;
  }

  private insertLeaf(node: Node): void {
    if (this.root === null) {
      this.root = node;
      this.recalc(node);
      return;
    }
    let cur = this.root;
    for (;;) {
      if (node.ts < cur.ts) {
        if (cur.left === null) {
          cur.left = node;
          node.parent = cur;
          this.recalc(node);
          return;
        }
        cur = cur.left;
      } else {
        if (cur.right === null) {
          cur.right = node;
          node.parent = cur;
          this.recalc(node);
          return;
        }
        cur = cur.right;
      }
    }
  }

  private rotateUp(node: Node): void {
    for (;;) {
      const p = node.parent;
      if (p === null || p.priority <= node.priority) {
        return;
      }
      const g = p.parent;
      if (p.left === node) {
        p.left = node.right;
        if (node.right !== null) {
          node.right.parent = p;
        }
        node.right = p;
      } else {
        p.right = node.left;
        if (node.left !== null) {
          node.left.parent = p;
        }
        node.left = p;
      }
      p.parent = node;
      node.parent = g;
      if (g === null) {
        this.root = node;
      } else if (g.left === p) {
        g.left = node;
      } else {
        g.right = node;
      }
      this.recalc(p);
      this.recalc(node);
    }
  }

  /** 最后一条 ts <= t 的记录。 */
  private floor(t: number): Node | null {
    let cur = this.root;
    let best: Node | null = null;
    while (cur !== null) {
      if (cur.ts <= t) {
        best = cur;
        cur = cur.right;
      } else {
        cur = cur.left;
      }
    }
    return best;
  }

  /** 第一条 ts >= t 的记录。 */
  private lowerBound(t: number): Node | null {
    let cur = this.root;
    let best: Node | null = null;
    while (cur !== null) {
      if (cur.ts >= t) {
        best = cur;
        cur = cur.left;
      } else {
        cur = cur.right;
      }
    }
    return best;
  }

  /** 严格位于 node 之前（ts 更小）的所有区间运行小时之和。 */
  private prefixHoursBefore(node: Node): number {
    let total = node.left !== null ? node.left.hours : 0;
    let cur = node;
    let p = cur.parent;
    while (p !== null) {
      if (p.right === cur) {
        total += (p.left !== null ? p.left.hours : 0) + p.delta;
      }
      cur = p;
      p = p.parent;
    }
    return total;
  }

  /** 按中序收集 [lo, hi] 范围内的子树聚合与单点聚合，O(log n) 个片段。 */
  private collectRange(
    node: Node | null,
    lo: number,
    hi: number,
    out: SubtreeAgg[],
  ): void {
    if (node === null || node.maxTs < lo || node.minTs > hi) {
      return;
    }
    if (lo <= node.minTs && node.maxTs <= hi) {
      out.push(node);
      return;
    }
    this.collectRange(node.left, lo, hi, out);
    if (lo <= node.ts && node.ts <= hi) {
      const single = this.aggOf(node);
      single.cnt = node.running ? 1 : 0;
      single.sy = node.running ? node.y : 0;
      single.so = 0;
      single.soy = 0;
      single.so2 = 0;
      single.hours = node.delta;
      out.push(single);
    }
    this.collectRange(node.right, lo, hi, out);
  }
}
