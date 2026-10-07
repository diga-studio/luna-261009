import assert from "node:assert/strict";
import { ErrorChange, ForestNodeInput } from "../src/planner";

/** Applies error changes to a forest input in place (mirrors updateErrors). */
export function applyChanges(forest: ForestNodeInput[], changes: ErrorChange[]): void {
  const byId = new Map<number, ForestNodeInput>();
  const walk = (node: ForestNodeInput): void => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of forest) walk(root);
  for (const change of changes) {
    const node = byId.get(change.id);
    assert.ok(node, `unknown node id ${change.id}`);
    node.error = change.error;
  }
}

/** All legal cuts of a single tree: {root} or the union of child cuts. */
function enumerateTreeCuts(node: ForestNodeInput): number[][] {
  const children = node.children ?? [];
  if (children.length === 0) return [[node.id]];
  let combos: number[][] = [[]];
  for (const child of children) {
    const childCuts = enumerateTreeCuts(child);
    const next: number[][] = [];
    for (const prefix of combos) {
      for (const cut of childCuts) {
        next.push(prefix.concat(cut));
      }
    }
    combos = next;
  }
  combos.push([node.id]);
  return combos;
}

export interface CutInfo {
  ids: number[];
  totalError: number;
}

/** Every legal cut of the forest (cartesian product over trees). */
export function enumerateCuts(forest: ForestNodeInput[]): number[][] {
  let combos: number[][] = [[]];
  for (const root of forest) {
    const treeCuts = enumerateTreeCuts(root);
    const next: number[][] = [];
    for (const prefix of combos) {
      for (const cut of treeCuts) {
        next.push(prefix.concat(cut));
      }
    }
    combos = next;
  }
  return combos;
}

export function errorOf(forest: ForestNodeInput[]): Map<number, number> {
  const map = new Map<number, number>();
  const walk = (node: ForestNodeInput): void => {
    map.set(node.id, node.error);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of forest) walk(root);
  return map;
}

export interface ReferenceResult {
  totalError: number;
  switches: number;
  selected: Set<number>;
}

/**
 * Independent brute-force optimum: among all legal cuts within budget, the
 * exact minimum total error, tie-broken by minimum switch count vs prevCut.
 */
export function referencePlan(
  forest: ForestNodeInput[],
  budget: number,
  prevCut: ReadonlySet<number>,
): ReferenceResult {
  const errors = errorOf(forest);
  let bestError = Infinity;
  let bestSwitches = Infinity;
  let best: number[] = [];
  for (const cut of enumerateCuts(forest)) {
    if (cut.length > budget) continue;
    let totalError = 0;
    let overlap = 0;
    for (const id of cut) {
      totalError += errors.get(id)!;
      if (prevCut.has(id)) overlap++;
    }
    const switches = prevCut.size + cut.length - 2 * overlap;
    if (totalError < bestError || (totalError === bestError && switches < bestSwitches)) {
      bestError = totalError;
      bestSwitches = switches;
      best = cut;
    }
  }
  return { totalError: bestError, switches: bestSwitches, selected: new Set<number>(best) };
}

/** Asserts every root-to-leaf path contains exactly one selected node. */
export function assertExactCover(forest: ForestNodeInput[], selected: ReadonlySet<number>): void {
  const walk = (node: ForestNodeInput, selectedOnPath: number): void => {
    const here = selectedOnPath + (selected.has(node.id) ? 1 : 0);
    assert.ok(here <= 1, `node ${node.id} selected together with an ancestor`);
    const children = node.children ?? [];
    if (children.length === 0) {
      assert.equal(here, 1, `leaf ${node.id} is not covered exactly once`);
      return;
    }
    for (const child of children) walk(child, here);
  };
  for (const root of forest) walk(root, 0);
}

/** All node ids of the forest. */
export function allIds(forest: ForestNodeInput[]): number[] {
  return [...errorOf(forest).keys()];
}
