/**
 * 通用最小费用流：在残量网络上用势函数 + Dijkstra 找最短路，逐路增广。
 * 支持负费用边（首次用 Bellman-Ford 初始化势函数）。
 */

/** 求解结果。 */
export interface MinCostFlowResult {
  /** 实际送达的流量（可能小于请求的 maxFlow）。 */
  readonly flow: number;
  /** 已送达流量的总费用（最小）。 */
  readonly cost: number;
  /** 每条输入边（按 addEdge 加入顺序）上最终通过的流量。 */
  readonly edgeFlows: readonly number[];
}

interface InternalEdge {
  to: number;
  /** 在 to 的邻接表中反向边的下标。 */
  rev: number;
  cap: number;
  cost: number;
  /** 对应的输入边序号；反向边为 -1。 */
  inputIndex: number;
}

export class MinCostFlow {
  private readonly adjacency: InternalEdge[][];
  private readonly inputs: { from: number; to: number; capacity: number }[] = [];

  constructor(nodeCount: number) {
    this.adjacency = Array.from({ length: nodeCount }, () => []);
  }

  /** 添加一条边，返回输入边序号（从 0 开始）。 */
  addEdge(from: number, to: number, capacity: number, cost: number): number {
    if (capacity < 0) throw new Error('capacity must be non-negative');
    const inputIndex = this.inputs.length;
    this.inputs.push({ from, to, capacity });
    const forward: InternalEdge = {
      to,
      rev: this.adjacency[to]!.length,
      cap: capacity,
      cost,
      inputIndex,
    };
    const backward: InternalEdge = {
      to: from,
      rev: this.adjacency[from]!.length,
      cap: 0,
      cost: -cost,
      inputIndex: -1,
    };
    this.adjacency[from]!.push(forward);
    this.adjacency[to]!.push(backward);
    return inputIndex;
  }

  /** 尝试从 source 向 sink 送达至多 maxFlow 单位流量，总费用最小。 */
  solve(source: number, sink: number, maxFlow: number): MinCostFlowResult {
    const nodeCount = this.adjacency.length;
    const potential = this.initialPotentials(source);
    let flow = 0;
    let cost = 0;

    while (flow < maxFlow) {
      const { dist, prevNode, prevEdge } = this.dijkstra(source, potential);
      if (!Number.isFinite(dist[sink]!)) break;
      for (let v = 0; v < nodeCount; v += 1) {
        if (Number.isFinite(dist[v]!)) potential[v] = potential[v]! + dist[v]!;
      }
      // 本次增广的瓶颈容量。
      let aug = maxFlow - flow;
      for (let v = sink; v !== source; v = prevNode[v]!) {
        aug = Math.min(aug, this.adjacency[prevNode[v]!]![prevEdge[v]!]!.cap);
      }
      for (let v = sink; v !== source; v = prevNode[v]!) {
        const edge = this.adjacency[prevNode[v]!]![prevEdge[v]!]!;
        edge.cap -= aug;
        this.adjacency[v]![edge.rev]!.cap += aug;
        cost += aug * edge.cost;
      }
      flow += aug;
    }

    const edgeFlows = this.inputs.map((input, index) => {
      const forward = this.adjacency[input.from]!.find(
        (edge) => edge.inputIndex === index,
      );
      return input.capacity - (forward ? forward.cap : 0);
    });
    return { flow, cost, edgeFlows };
  }

  /** Bellman-Ford 初始化势函数，处理可能存在的负费用边。 */
  private initialPotentials(source: number): number[] {
    const nodeCount = this.adjacency.length;
    const dist = new Array<number>(nodeCount).fill(Infinity);
    dist[source] = 0;
    for (let round = 0; round < nodeCount - 1; round += 1) {
      let changed = false;
      for (let v = 0; v < nodeCount; v += 1) {
        if (!Number.isFinite(dist[v]!)) continue;
        for (const edge of this.adjacency[v]!) {
          if (edge.cap > 0 && dist[v]! + edge.cost < dist[edge.to]!) {
            dist[edge.to] = dist[v]! + edge.cost;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return dist.map((d) => (Number.isFinite(d) ? d : 0));
  }

  /** 在约化费用上跑 Dijkstra（二叉堆）。 */
  private dijkstra(
    source: number,
    potential: readonly number[],
  ): { dist: number[]; prevNode: number[]; prevEdge: number[] } {
    const nodeCount = this.adjacency.length;
    const dist = new Array<number>(nodeCount).fill(Infinity);
    const prevNode = new Array<number>(nodeCount).fill(-1);
    const prevEdge = new Array<number>(nodeCount).fill(-1);
    dist[source] = 0;
    // 简易二叉堆，元素为 [距离, 节点]。
    const heap: [number, number][] = [[0, source]];
    const push = (item: [number, number]): void => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent]![0] <= heap[i]![0]) break;
        [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
        i = parent;
      }
    };
    const pop = (): [number, number] | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1;
          const right = left + 1;
          let smallest = i;
          if (left < heap.length && heap[left]![0] < heap[smallest]![0]) smallest = left;
          if (right < heap.length && heap[right]![0] < heap[smallest]![0]) smallest = right;
          if (smallest === i) break;
          [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
          i = smallest;
        }
      }
      return top;
    };

    for (;;) {
      const item = pop();
      if (!item) break;
      const [d, v] = item;
      if (d > dist[v]!) continue;
      const edges = this.adjacency[v]!;
      for (let ei = 0; ei < edges.length; ei += 1) {
        const edge = edges[ei]!;
        if (edge.cap <= 0) continue;
        const reduced = edge.cost + potential[v]! - potential[edge.to]!;
        const nd = d + reduced;
        if (nd < dist[edge.to]!) {
          dist[edge.to] = nd;
          prevNode[edge.to] = v;
          prevEdge[edge.to] = ei;
          push([nd, edge.to]);
        }
      }
    }
    return { dist, prevNode, prevEdge };
  }
}
