/**
 * Aggregates over a contiguous index range of telemetry records.
 * All "localP" quantities measure cumulative operating hours from the
 * left edge of the node range, so nodes compose left-to-right.
 */
export interface NodeAgg {
  /** Number of running (speed > 0) records. */
  cnt: number;
  /** Sum of running interval hours d_j = r_j * (t_{j+1} - t_j). */
  sumD: number;
  /** Sum of r_j * y_j (normalized head of running records). */
  sumY: number;
  /** Sum of r_j * localP_j. */
  sumRP: number;
  /** Sum of r_j * localP_j^2. */
  sumRP2: number;
  /** Sum of r_j * localP_j * y_j. */
  sumRPY: number;
}

export const IDENTITY: NodeAgg = {
  cnt: 0,
  sumD: 0,
  sumY: 0,
  sumRP: 0,
  sumRP2: 0,
  sumRPY: 0,
};

/**
 * Ordered merge: `right`'s localP values shift by the operating hours
 * accumulated across `left` (left.sumD).
 */
export function merge(left: NodeAgg, right: NodeAgg): NodeAgg {
  return {
    cnt: left.cnt + right.cnt,
    sumD: left.sumD + right.sumD,
    sumY: left.sumY + right.sumY,
    sumRP: left.sumRP + left.sumD * right.cnt + right.sumRP,
    sumRP2:
      left.sumRP2 +
      left.sumD * left.sumD * right.cnt +
      2 * left.sumD * right.sumRP +
      right.sumRP2,
    sumRPY: left.sumRPY + left.sumD * right.sumY + right.sumRPY,
  };
}

/**
 * Iterative segment tree over a fixed number of records.
 * Point updates and ordered range aggregation in O(log n).
 */
export class SegmentTree {
  private readonly size: number;
  private readonly nodes: NodeAgg[];

  constructor(leafCount: number) {
    let size = 1;
    while (size < Math.max(1, leafCount)) size *= 2;
    this.size = size;
    this.nodes = new Array<NodeAgg>(2 * size);
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodes[i] = { ...IDENTITY };
    }
  }

  /** Bulk-load leaves and rebuild all internal nodes in O(n). */
  load(leaves: NodeAgg[]): void {
    for (let i = 0; i < leaves.length; i++) {
      this.nodes[this.size + i] = leaves[i];
    }
    for (let i = this.size - 1; i >= 1; i--) {
      this.nodes[i] = merge(this.nodes[2 * i], this.nodes[2 * i + 1]);
    }
  }

  setLeaf(index: number, leaf: NodeAgg): void {
    this.nodes[this.size + index] = leaf;
    let i = (this.size + index) >> 1;
    while (i >= 1) {
      this.nodes[i] = merge(this.nodes[2 * i], this.nodes[2 * i + 1]);
      i >>= 1;
    }
  }

  /** Inclusive range query; returns the ordered merge of [from, to]. */
  query(from: number, to: number): NodeAgg {
    let l = from + this.size;
    let r = to + this.size;
    let accL: NodeAgg = { ...IDENTITY };
    let accR: NodeAgg = { ...IDENTITY };
    while (l <= r) {
      if (l % 2 === 1) {
        accL = merge(accL, this.nodes[l]);
        l++;
      }
      if (r % 2 === 0) {
        accR = merge(this.nodes[r], accR);
        r--;
      }
      l >>= 1;
      r >>= 1;
    }
    return merge(accL, accR);
  }
}
