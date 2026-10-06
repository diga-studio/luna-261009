/**
 * Max-weight bipartite matching between actions (left) and steps (right).
 * Each action matches at most one step, each step takes at most one action.
 * Hungarian algorithm (Kuhn-Munkres), O(n^2 * m). Missing edges and
 * "leave unmatched" are modeled as zero-weight edges; real edge weights
 * are always positive, so the optimum never prefers a dummy edge.
 */
export interface MatchingEdge {
  actionIndex: number;
  stepIndex: number;
  weight: number;
}

export interface MatchingResult {
  totalWeight: number;
  /** actionIndex -> stepIndex */
  pairs: Map<number, number>;
}

export function maxWeightMatching(
  actionCount: number,
  stepCount: number,
  edges: MatchingEdge[],
): MatchingResult {
  const pairs = new Map<number, number>();
  if (actionCount === 0 || stepCount === 0) {
    return { totalWeight: 0, pairs };
  }

  // Hungarian needs left side <= right side; swap sides if needed.
  const swapped = actionCount > stepCount;
  const n = swapped ? stepCount : actionCount;
  const m = swapped ? actionCount : stepCount;

  // 1-indexed weight matrix, zero-filled.
  const a: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (const e of edges) {
    const row = swapped ? e.stepIndex : e.actionIndex;
    const col = swapped ? e.actionIndex : e.stepIndex;
    const w = a[row + 1]![col + 1]!;
    if (e.weight > w) a[row + 1]![col + 1] = e.weight;
  }

  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = -(a[i0]![j]!) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  let totalWeight = 0;
  for (let j = 1; j <= m; j++) {
    const i = p[j]!;
    if (i === 0) continue;
    const w = a[i]![j]!;
    if (w <= 0) continue; // dummy pairing, contributes nothing
    totalWeight += w;
    const actionIndex = swapped ? j - 1 : i - 1;
    const stepIndex = swapped ? i - 1 : j - 1;
    pairs.set(actionIndex, stepIndex);
  }
  return { totalWeight, pairs };
}
