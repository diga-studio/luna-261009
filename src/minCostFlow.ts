/**
 * 通用最小费用最大流。
 * 容量为非负整数，费用为非负整数；逐单位沿最短路增广（SPFA），
 * 图很小（数十节点、六十单位流量），实现以清晰正确为先。
 */

interface InternalEdge {
  to: number;
  rev: number;
  capacity: number;
  cost: number;
}

export interface EdgeHandle {
  from: number;
  edgeIndex: number;
}

export class MinCostFlow {
  private readonly graph: InternalEdge[][];

  constructor(nodeCount: number) {
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  /** 添加一条有向边，返回边句柄供事后读取流量。 */
  addEdge(from: number, to: number, capacity: number, cost: number): EdgeHandle {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error(`invalid capacity: ${capacity}`);
    }
    if (!Number.isInteger(cost) || cost < 0) {
      throw new Error(`invalid cost: ${cost}`);
    }
    const forward: InternalEdge = { to, rev: this.graph[to]!.length, capacity, cost };
    const backward: InternalEdge = { to: from, rev: this.graph[from]!.length, capacity: 0, cost: -cost };
    this.graph[from]!.push(forward);
    this.graph[to]!.push(backward);
    return { from, edgeIndex: this.graph[from]!.length - 1 };
  }

  /**
   * 尝试从 source 到 sink 推送 targetFlow 单位流量。
   * 返回实际推送的流量与对应的最小总费用。
   */
  solve(source: number, sink: number, targetFlow: number): { flow: number; cost: number } {
    let flow = 0;
    let cost = 0;
    const nodeCount = this.graph.length;
    const dist = new Array<number>(nodeCount);
    const prevNode = new Array<number>(nodeCount);
    const prevEdge = new Array<number>(nodeCount);
    const inQueue = new Array<boolean>(nodeCount);

    while (flow < targetFlow) {
      // SPFA 找 source 到 sink 的最短（费用最小）路径。
      dist.fill(Number.POSITIVE_INFINITY);
      inQueue.fill(false);
      dist[source] = 0;
      const queue: number[] = [source];
      inQueue[source] = true;
      for (let head = 0; head < queue.length; head += 1) {
        const node = queue[head]!;
        inQueue[node] = false;
        const edges = this.graph[node]!;
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
          const edge = edges[edgeIndex]!;
          if (edge.capacity <= 0) continue;
          const candidate = dist[node]! + edge.cost;
          if (candidate < dist[edge.to]!) {
            dist[edge.to] = candidate;
            prevNode[edge.to] = node;
            prevEdge[edge.to] = edgeIndex;
            if (!inQueue[edge.to]) {
              queue.push(edge.to);
              inQueue[edge.to] = true;
            }
          }
        }
      }
      if (dist[sink] === Number.POSITIVE_INFINITY) break;

      // 本网络所有边容量均为整数且瓶颈为 1 的边居多，逐单位增广即可。
      let node = sink;
      while (node !== source) {
        const from = prevNode[node]!;
        const edgeIndex = prevEdge[node]!;
        const edge = this.graph[from]![edgeIndex]!;
        edge.capacity -= 1;
        this.graph[node]![edge.rev]!.capacity += 1;
        node = from;
      }
      flow += 1;
      cost += dist[sink]!;
    }
    return { flow, cost };
  }

  /** 读取 addEdge 返回句柄对应边上的流量。 */
  flowOn(handle: EdgeHandle): number {
    const edge = this.graph[handle.from]![handle.edgeIndex]!;
    return this.graph[edge.to]![edge.rev]!.capacity;
  }
}
