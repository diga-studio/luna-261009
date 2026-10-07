export const DEFAULT_BUDGET = 200;

export interface ForestNodeInput {
  id: number;
  error: number;
  children?: ForestNodeInput[];
}

export interface ErrorChange {
  id: number;
  error: number;
}

export interface PlanResult {
  /** Ids of the nodes forming the active cut. */
  selected: number[];
  /** Sum of errors of the selected nodes. */
  totalError: number;
  /** |previous \ current| + |current \ previous| against the last planned cut. */
  switches: number;
}

export interface ChunkPlanner {
  updateErrors(changes: ErrorChange[]): void;
  plan(): PlanResult;
}

const MAX_DEPTH = 8;
const MAX_ROOTS = 200;
const MAX_NODES = 20000;
const MAX_ERROR = 1_000_000_000;

// Objective keys combine (totalError, switchPenalty) lexicographically into a
// single exact number: key = totalError * KEY_SCALE + switchPenalty.
// switchPenalty is sum over selected nodes of (inPreviousCut ? -1 : +1), so it
// lies in [-budget, budget]; KEY_SCALE must exceed that span. Minimizing the
// key minimizes total error first and switch count second, because
// switches = |prev| + sum(switchPenalty) with |prev| constant.
const KEY_SCALE = 1024;
const INF = Number.POSITIVE_INFINITY;

interface PlannerState {
  budget: number;
  nodeCount: number;
  rootCount: number;
  /** Flat arrays indexed by internal node index. */
  ids: Int32Array;
  errors: Float64Array;
  /** CSR children storage. */
  childStart: Uint32Array;
  childList: Uint32Array;
  /** Roots as internal indices. */
  roots: Uint32Array;
  /** id -> internal index. */
  indexById: Map<number, number>;
  /** Ids of the previously planned cut (initially all roots). */
  previousCut: Set<number>;
  /** Membership of internal indices in the previous cut. */
  inPreviousCut: Uint8Array;
  /** Children-before-parents traversal order (structure is immutable). */
  order: Uint32Array;
}

function validateErrorValue(error: number, context: string): void {
  if (!Number.isInteger(error) || error < 0 || error > MAX_ERROR) {
    throw new Error(`${context}: error must be an integer in [0, ${MAX_ERROR}], got ${error}`);
  }
}

function buildState(forest: ForestNodeInput[], budget: number): PlannerState {
  if (!Array.isArray(forest)) {
    throw new Error("forest must be an array of root nodes");
  }
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error("budget must be a positive integer");
  }
  if (forest.length > MAX_ROOTS) {
    throw new Error(`forest has ${forest.length} roots, max ${MAX_ROOTS}`);
  }

  const ids: number[] = [];
  const errors: number[] = [];
  const childrenOf: number[][] = [];
  const roots: number[] = [];
  const indexById = new Map<number, number>();

  // Iterative pre-order traversal so children are contiguous per parent.
  interface Frame {
    node: ForestNodeInput;
    parent: number;
    depth: number;
  }
  const stack: Frame[] = [];
  for (let i = forest.length - 1; i >= 0; i--) {
    stack.push({ node: forest[i]!, parent: -1, depth: 1 });
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node, depth } = frame;
    if (depth > MAX_DEPTH) {
      throw new Error(`tree depth exceeds ${MAX_DEPTH} levels`);
    }
    if (!Number.isInteger(node.id)) {
      throw new Error(`node id must be an integer, got ${node.id}`);
    }
    if (indexById.has(node.id)) {
      throw new Error(`duplicate node id ${node.id}`);
    }
    validateErrorValue(node.error, `node ${node.id}`);
    const index = ids.length;
    indexById.set(node.id, index);
    ids.push(node.id);
    errors.push(node.error);
    childrenOf.push([]);
    if (frame.parent >= 0) {
      childrenOf[frame.parent]!.push(index);
    } else {
      roots.push(index);
    }
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, parent: index, depth: depth + 1 });
    }
  }

  const nodeCount = ids.length;
  if (nodeCount > MAX_NODES) {
    throw new Error(`forest has ${nodeCount} nodes, max ${MAX_NODES}`);
  }

  // Structural numeric invariants: leaves have error 0, internal nodes have
  // error >= sum of direct children errors.
  for (let i = 0; i < nodeCount; i++) {
    const children = childrenOf[i]!;
    if (children.length === 0) {
      if (errors[i] !== 0) {
        throw new Error(`leaf node ${ids[i]} must have error 0, got ${errors[i]}`);
      }
    } else {
      let sum = 0;
      for (const c of children) sum += errors[c]!;
      if (errors[i]! < sum) {
        throw new Error(
          `node ${ids[i]} error ${errors[i]} is less than the sum of its children's errors ${sum}`,
        );
      }
    }
  }

  const childStart = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    childStart[i + 1] = childStart[i]! + childrenOf[i]!.length;
  }
  const childList = new Uint32Array(childStart[nodeCount]!);
  for (let i = 0; i < nodeCount; i++) {
    const start = childStart[i]!;
    const children = childrenOf[i]!;
    for (let j = 0; j < children.length; j++) {
      childList[start + j] = children[j]!;
    }
  }

  return {
    budget,
    nodeCount,
    rootCount: roots.length,
    ids: Int32Array.from(ids),
    errors: Float64Array.from(errors),
    childStart,
    childList,
    roots: Uint32Array.from(roots),
    indexById,
    previousCut: new Set<number>(roots.map((i) => ids[i]!)),
    inPreviousCut: (() => {
      const marks = new Uint8Array(nodeCount);
      for (const r of roots) marks[r] = 1;
      return marks;
    })(),
    order: new Uint32Array(0),
  };
}

/** Children-before-parents order over the whole forest. */
function computePostOrder(state: PlannerState): Uint32Array {
  const { nodeCount, roots, childStart, childList } = state;
  const order = new Uint32Array(nodeCount);
  let pos = 0;
  const stack: number[] = [];
  for (let r = roots.length - 1; r >= 0; r--) stack.push(roots[r]!);
  // Pre-order traversal, then reversed: every child precedes its parent.
  const expanded: number[] = [];
  while (stack.length > 0) {
    const i = stack.pop()!;
    expanded.push(i);
    for (let c = childStart[i]!; c < childStart[i + 1]!; c++) {
      stack.push(childList[c]!);
    }
  }
  for (let i = expanded.length - 1; i >= 0; i--) {
    order[pos++] = expanded[i]!;
  }
  return order;
}

interface Tables {
  /** offsets[i] .. offsets[i]+lengths[i]-1 is node i's row in `values`. */
  offsets: Uint32Array;
  /** lengths[i] = min(maxCutSize(i), budget); row entry j is cut size j+1. */
  lengths: Uint32Array;
  values: Float64Array;
}

/**
 * For every node, values[offsets[i] + k - 1] is the minimum objective key
 * among legal cuts of that node's subtree using exactly k selected nodes.
  * k = 1 is the better of selecting the node itself (proxy for the whole
  * subtree) and the best size-1 cut forwarded up a single-child chain;
  * k >= 2 is the bounded knapsack merge of the children's rows.
 */
function computeTables(state: PlannerState, order: Uint32Array): Tables {
  const { nodeCount, budget, errors, inPreviousCut, childStart, childList } = state;
  const lengths = new Uint32Array(nodeCount);
  for (let o = 0; o < nodeCount; o++) {
    const i = order[o]!;
    // Maximum legal cut size of this subtree: 1 for a leaf, otherwise the
    // sum of the children's maxima (fully expanding every child).
    let size = childStart[i]! === childStart[i + 1]! ? 1 : 0;
    for (let c = childStart[i]!; c < childStart[i + 1]!; c++) {
      size += lengths[childList[c]!]!;
    }
    lengths[i] = Math.min(size, budget);
  }
  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    offsets[i + 1] = offsets[i]! + lengths[i]!;
  }
  const values = new Float64Array(offsets[nodeCount]!);

  // Reusable scratch rows for the sequential child merge.
  const cur = new Float64Array(budget + 1);
  const next = new Float64Array(budget + 1);

  for (let o = 0; o < nodeCount; o++) {
    const i = order[o]!;
    const off = offsets[i]!;
    const len = lengths[i]!;
    const proxyKey = errors[i]! * KEY_SCALE + (inPreviousCut[i]! === 1 ? -1 : 1);
    const c0 = childStart[i]!;
    const c1 = childStart[i + 1]!;
    if (c0 === c1) {
      values[off] = proxyKey;
      continue; // leaf: only k = 1
    }

    cur.fill(INF);
    const firstChild = childList[c0]!;
    const firstOff = offsets[firstChild]!;
    const firstLen = lengths[firstChild]!;
    for (let k = 1; k <= firstLen; k++) {
      cur[k] = values[firstOff + k - 1]!;
    }
    let curMax = firstLen;
    for (let c = c0 + 1; c < c1; c++) {
      const child = childList[c]!;
      const childOff = offsets[child]!;
      const childLen = lengths[child]!;
      const newMax = Math.min(curMax + childLen, budget);
      next.fill(INF);
      for (let k = 2; k <= newMax; k++) {
        let best = INF;
        const tLo = Math.max(1, k - curMax);
        const tHi = Math.min(childLen, k - 1);
        for (let t = tLo; t <= tHi; t++) {
          const v = cur[k - t]! + values[childOff + t - 1]!;
          if (v < best) best = v;
        }
        next[k] = best;
      }
      cur.set(next);
      curMax = newMax;
    }
    // A size-1 cut is either this node as a proxy or, through single-child
    // chains, the best size-1 cut forwarded from below.
    values[off] = Math.min(proxyKey, cur[1]!);
    for (let k = 2; k <= len; k++) {
      values[off + k - 1] = cur[k]!;
    }
  }
  return { offsets, lengths, values };
}

interface RowRef {
  off: number;
  len: number;
}

function rowsOfChildren(state: PlannerState, tables: Tables, node: number): RowRef[] {
  const rows: RowRef[] = [];
  for (let c = state.childStart[node]!; c < state.childStart[node + 1]!; c++) {
    const child = state.childList[c]!;
    rows.push({ off: tables.offsets[child]!, len: tables.lengths[child]! });
  }
  return rows;
}

/**
 * Sequential bounded knapsack merge: result[k] is the minimum combined key
 * using exactly k selected nodes across all rows (each row contributes >= 1).
 */
function mergeRowKeys(rows: RowRef[], values: Float64Array, budget: number): Float64Array {
  const cur = new Float64Array(budget + 1).fill(INF);
  const first = rows[0]!;
  for (let k = 1; k <= first.len; k++) cur[k] = values[first.off + k - 1]!;
  let curMax = first.len;
  const next = new Float64Array(budget + 1);
  for (let j = 1; j < rows.length; j++) {
    const row = rows[j]!;
    const newMax = Math.min(curMax + row.len, budget);
    next.fill(INF);
    for (let k = 2; k <= newMax; k++) {
      let best = INF;
      const tLo = Math.max(1, k - curMax);
      const tHi = Math.min(row.len, k - 1);
      for (let t = tLo; t <= tHi; t++) {
        const v = cur[k - t]! + values[row.off + t - 1]!;
        if (v < best) best = v;
      }
      next[k] = best;
    }
    cur.set(next);
    curMax = newMax;
  }
  return cur;
}

/**
 * Recomputes the merge of `rows` while recording splits, then backtracks the
 * per-row allocation summing to targetK that attains the minimum key.
 */
function allocate(rows: RowRef[], values: Float64Array, budget: number, targetK: number): number[] {
  const m = rows.length;
  const first = rows[0]!;
  let cur = new Float64Array(budget + 1).fill(INF);
  for (let k = 1; k <= first.len; k++) cur[k] = values[first.off + k - 1]!;
  let curMax = first.len;
  const choices: Int16Array[] = new Array<Int16Array>(m);
  choices[0] = new Int16Array(budget + 1);
  for (let j = 1; j < m; j++) {
    const row = rows[j]!;
    const newMax = Math.min(curMax + row.len, budget);
    const next = new Float64Array(budget + 1).fill(INF);
    const choice = new Int16Array(budget + 1);
    for (let k = 2; k <= newMax; k++) {
      let best = INF;
      let bestT = 0;
      const tLo = Math.max(1, k - curMax);
      const tHi = Math.min(row.len, k - 1);
      for (let t = tLo; t <= tHi; t++) {
        const v = cur[k - t]! + values[row.off + t - 1]!;
        if (v < best) {
          best = v;
          bestT = t;
        }
      }
      next[k] = best;
      choice[k] = bestT;
    }
    choices[j] = choice;
    cur = next;
    curMax = newMax;
  }
  const allocation = new Array<number>(m);
  let remaining = targetK;
  for (let j = m - 1; j >= 1; j--) {
    const t = choices[j]![remaining]!;
    allocation[j] = t;
    remaining -= t;
  }
  allocation[0] = remaining;
  return allocation;
}

function reconstruct(
  state: PlannerState,
  tables: Tables,
  node: number,
  k: number,
  out: number[],
): void {
  if (k === 1 && state.childStart[node]! === state.childStart[node + 1]!) {
    out.push(node);
    return;
  }
  if (k === 1) {
    // A size-1 cut is this node as a proxy only when the proxy attains the
    // stored minimum; otherwise the optimum was forwarded from a child.
    const proxyKey =
      state.errors[node]! * KEY_SCALE + (state.inPreviousCut[node]! === 1 ? -1 : 1);
    if (tables.values[tables.offsets[node]!] === proxyKey) {
      out.push(node);
      return;
    }
  }
  const rows = rowsOfChildren(state, tables, node);
  const allocation = allocate(rows, tables.values, state.budget, k);
  let c = state.childStart[node]!;
  for (let j = 0; j < rows.length; j++) {
    reconstruct(state, tables, state.childList[c + j]!, allocation[j]!, out);
  }
}

function validateStructuralConstraints(state: PlannerState): void {
  const { nodeCount, ids, errors, childStart } = state;
  for (let i = 0; i < nodeCount; i++) {
    if (childStart[i]! === childStart[i + 1]!) {
      if (errors[i] !== 0) {
        throw new Error(`leaf node ${ids[i]} must have error 0, got ${errors[i]}`);
      }
    } else {
      let sum = 0;
      for (let c = childStart[i]!; c < childStart[i + 1]!; c++) {
        sum += errors[state.childList[c]!]!;
      }
      if (errors[i]! < sum) {
        throw new Error(
          `node ${ids[i]} error ${errors[i]} is less than the sum of its children's errors ${sum}`,
        );
      }
    }
  }
}

export function createChunkPlanner(
  forest: ForestNodeInput[],
  budget: number = DEFAULT_BUDGET,
): ChunkPlanner {
  const state = buildState(forest, budget);
  state.order = computePostOrder(state);

  function updateErrors(changes: ErrorChange[]): void {
    for (const change of changes) {
      const index = state.indexById.get(change.id);
      if (index === undefined) {
        throw new Error(`unknown node id ${change.id}`);
      }
      validateErrorValue(change.error, `node ${change.id}`);
      state.errors[index] = change.error;
    }
    validateStructuralConstraints(state);
  }

  function plan(): PlanResult {
    if (state.rootCount === 0) {
      return { selected: [], totalError: 0, switches: 0 };
    }
    const tables = computeTables(state, state.order);
    const rootRows: RowRef[] = [];
    for (let r = 0; r < state.rootCount; r++) {
      const root = state.roots[r]!;
      rootRows.push({ off: tables.offsets[root]!, len: tables.lengths[root]! });
    }
    const merged = mergeRowKeys(rootRows, tables.values, state.budget);
    let bestK = -1;
    let bestKey = INF;
    for (let k = state.rootCount; k <= state.budget; k++) {
      if (merged[k]! < bestKey) {
        bestKey = merged[k]!;
        bestK = k;
      }
    }
    if (bestK < 0) {
      throw new Error("no feasible cut within budget");
    }
    const rootAllocation = allocate(rootRows, tables.values, state.budget, bestK);
    const selectedInternal: number[] = [];
    for (let r = 0; r < state.rootCount; r++) {
      reconstruct(state, tables, state.roots[r]!, rootAllocation[r]!, selectedInternal);
    }

    const selected: number[] = new Array<number>(selectedInternal.length);
    let totalError = 0;
    for (let i = 0; i < selectedInternal.length; i++) {
      const index = selectedInternal[i]!;
      selected[i] = state.ids[index]!;
      totalError += state.errors[index]!;
    }

    let overlap = 0;
    for (const id of selected) {
      if (state.previousCut.has(id)) overlap++;
    }
    const switches = state.previousCut.size + selected.length - 2 * overlap;

    state.previousCut = new Set<number>(selected);
    state.inPreviousCut.fill(0);
    for (const index of selectedInternal) {
      state.inPreviousCut[index] = 1;
    }

    return { selected, totalError, switches };
  }

  return { updateErrors, plan };
}
