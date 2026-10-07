import test from "node:test";
import assert from "node:assert/strict";
import { createChunkPlanner } from "../src/planner";
import { applyChanges, assertExactCover, referencePlan } from "./helpers";
import { ForestNodeInput } from "../src/planner";

function buildCompetitionForest(): ForestNodeInput[] {
  const forest: ForestNodeInput[] = [];
  // 196 zero-error single-leaf objects occupy 196 of the 200 slots.
  for (let i = 1; i <= 196; i++) {
    forest.push({ id: i, error: 0 });
  }
  // Object A: expanding the root yields no immediate gain (100 -> 50+50);
  // only the second expansion pays off (50 -> 0+0 per branch).
  forest.push({
    id: 1000,
    error: 100,
    children: [
      { id: 1001, error: 50, children: [{ id: 1003, error: 0 }, { id: 1004, error: 0 }] },
      { id: 1002, error: 50, children: [{ id: 1005, error: 0 }, { id: 1006, error: 0 }] },
    ],
  });
  // Object B: every expansion gives an immediate but smaller gain.
  forest.push({
    id: 2000,
    error: 40,
    children: [
      { id: 2001, error: 20, children: [{ id: 2003, error: 0 }, { id: 2004, error: 0 }] },
      { id: 2002, error: 10, children: [{ id: 2005, error: 0 }, { id: 2006, error: 0 }] },
    ],
  });
  return forest;
}

test("zero-gain expansion can be a prerequisite for later high-gain expansion", () => {
  const forest = buildCompetitionForest();
  const planner = createChunkPlanner(forest);

  // Previous cut is all roots: the 196 singletons plus 1000 and 2000.
  const previousCut = new Set<number>();
  for (let i = 1; i <= 196; i++) previousCut.add(i);
  previousCut.add(1000);
  previousCut.add(2000);

  const reference = referencePlan(forest, 200, previousCut);
  // Sanity check the scenario design: the optimum spends 3 of the 4 free
  // slots on object A (loss 50) and keeps B at its root (loss 40).
  assert.equal(reference.totalError, 90);

  const result = planner.plan();
  assert.equal(result.totalError, reference.totalError);
  assert.equal(result.switches, reference.switches);
  assert.ok(result.selected.length <= 200);
  assertExactCover(forest, new Set(result.selected));
  // The optimum must expand A twice (through the zero-gain first expansion).
  const selected = new Set(result.selected);
  assert.ok(!selected.has(1000), "root of A must be expanded");
  assert.ok(selected.has(2000), "B must stay at its root");

  // Re-planning without updates must reproduce the identical cut.
  const again = planner.plan();
  assert.equal(again.switches, 0);
  assert.deepEqual(new Set(again.selected), new Set(result.selected));
  assert.equal(again.totalError, result.totalError);
});

function buildTransferForest(): ForestNodeInput[] {
  const forest: ForestNodeInput[] = [];
  for (let i = 1; i <= 196; i++) {
    forest.push({ id: i, error: 0 });
  }
  // X: 1000(110) -> [1001(60) -> [1003, 1004], 1002(50) -> [1005, 1006]]
  forest.push({
    id: 1000,
    error: 110,
    children: [
      { id: 1001, error: 60, children: [{ id: 1003, error: 0 }, { id: 1004, error: 0 }] },
      { id: 1002, error: 50, children: [{ id: 1005, error: 0 }, { id: 1006, error: 0 }] },
    ],
  });
  // Y: 2000(50) -> [2001(30) -> [2003, 2004], 2002(20) -> [2005, 2006]]
  forest.push({
    id: 2000,
    error: 50,
    children: [
      { id: 2001, error: 30, children: [{ id: 2003, error: 0 }, { id: 2004, error: 0 }] },
      { id: 2002, error: 20, children: [{ id: 2005, error: 0 }, { id: 2006, error: 0 }] },
    ],
  });
  return forest;
}

test("budget transfers between objects and ties break on global switch count", () => {
  const forest = buildTransferForest();
  const planner = createChunkPlanner(forest);
  let previousCut = new Set<number>();
  for (let i = 1; i <= 196; i++) previousCut.add(i);
  previousCut.add(1000);
  previousCut.add(2000);

  const checkAgainstReference = (result: { selected: number[]; totalError: number; switches: number }) => {
    const reference = referencePlan(forest, 200, previousCut);
    assert.equal(result.totalError, reference.totalError, "total error must match brute force");
    assert.equal(result.switches, reference.switches, "switches must match brute force");
    assert.ok(result.selected.length <= 200);
    assertExactCover(forest, new Set(result.selected));
    previousCut = new Set(result.selected);
  };

  const update = (changes: { id: number; error: number }[]) => {
    planner.updateErrors(changes);
    applyChanges(forest, changes);
  };

  // Phase 1: X expands to {1003,1004,1002} (loss 50), Y stays at its root
  // (loss 50). Total 100, switches 4.
  checkAgainstReference(planner.plan());
  assert.equal(previousCut.has(1003) && previousCut.has(1002) && previousCut.has(2000), true);

  // Phase 2: Y's root becomes expensive; the whole X subtree must merge back
  // to its root so the budget can move to Y. Loss 130 via {1000} + Y leaves.
  update([{ id: 2000, error: 150 }]);
  checkAgainstReference(planner.plan());
  assert.ok(previousCut.has(1000), "X must merge back to its root");
  assert.ok(previousCut.has(2003) && previousCut.has(2004) && previousCut.has(2002));

  // Phase 3: budget moves back into a partially expanded X while Y merges.
  update([
    { id: 1001, error: 40 },
    { id: 1002, error: 30 },
    { id: 2000, error: 60 },
    { id: 2001, error: 10 },
    { id: 2002, error: 30 },
  ]);
  checkAgainstReference(planner.plan());
  assert.ok(previousCut.has(1003) && previousCut.has(1004) && previousCut.has(1002));
  assert.ok(previousCut.has(2000), "Y must merge back to its root");

  // Phase 4: engineered loss tie at 30 between cuts {1000,2001,2002},
  // {1000,2003,2004,2002}, {1000,2001,2005,2006} and {1001,1002,2001,2002}.
  // The previous cut is not loss-optimal; the unique minimum-switch optimum
  // keeps node 1002 from the previous cut and costs 6 switches.
  update([
    { id: 1000, error: 30 },
    { id: 1001, error: 0 },
    { id: 2000, error: 90 },
    { id: 2001, error: 0 },
    { id: 2002, error: 0 },
  ]);
  const tied = planner.plan();
  checkAgainstReference(tied);
  assert.equal(tied.totalError, 30);
  assert.equal(tied.switches, 6);
  const expected = new Set<number>([1001, 1002, 2001, 2002]);
  for (let i = 1; i <= 196; i++) expected.add(i);
  assert.deepEqual(new Set(tied.selected), expected);
});

interface BigTreeSpec {
  forest: ForestNodeInput[];
  byId: Map<number, ForestNodeInput>;
}

/**
 * 100 trees x 200 nodes = 20000 nodes. Each tree is a chain of 8 levels
 * (chain node at depth d has one chain child at depth d+1) padded with leaf
 * children, so every tree contains a root-to-leaf path of exactly 8 levels.
 */
function buildLargeForest(): BigTreeSpec {
  const forest: ForestNodeInput[] = [];
  const byId = new Map<number, ForestNodeInput>();
  let nextId = 1;
  for (let t = 0; t < 100; t++) {
    // 8 chain nodes + 192 padding leaves = 200 nodes per tree.
    const leavesPerLevel = [28, 28, 28, 28, 28, 28, 24, 0];
    let chain: ForestNodeInput | undefined;
    const levelNodes: ForestNodeInput[] = [];
    for (let level = 8; level >= 1; level--) {
      const node: ForestNodeInput = { id: nextId++, error: 0, children: [] };
      for (let i = 0; i < leavesPerLevel[level - 1]!; i++) {
        node.children!.push({ id: nextId++, error: 0 });
      }
      if (chain) node.children!.push(chain);
      chain = node;
      levelNodes.push(node);
    }
    // Assign errors bottom-up: leaves 0, internal = sum(children) + id % 7.
    const assign = (node: ForestNodeInput): number => {
      byId.set(node.id, node);
      const children = node.children ?? [];
      if (children.length === 0) {
        node.error = 0;
        return 0;
      }
      let sum = 0;
      for (const child of children) sum += assign(child);
      node.error = sum + (node.id % 7);
      return node.error;
    };
    assign(chain!);
    forest.push(chain!);
  }
  return { forest, byId };
}

function sumOfChildrenErrors(node: ForestNodeInput): number {
  let sum = 0;
  for (const child of node.children ?? []) sum += child.error;
  return sum;
}

test("20000-node forest with 8-level paths: plan, update, replan, stabilize", () => {
  const { forest, byId } = buildLargeForest();
  assert.equal(byId.size, 20000);

  const planner = createChunkPlanner(forest);
  const checkInvariants = (result: { selected: number[]; totalError: number; switches: number }) => {
    assert.ok(result.selected.length <= 200, "cut must fit the budget");
    assert.ok(result.selected.length >= 100, "every tree contributes at least one fragment");
    assertExactCover(forest, new Set(result.selected));
    let actualLoss = 0;
    for (const id of result.selected) actualLoss += byId.get(id)!.error;
    assert.equal(result.totalError, actualLoss, "reported loss must match selected nodes");
  };

  const first = planner.plan();
  checkInvariants(first);

  // Updates that keep every numeric invariant: raise some roots arbitrarily,
  // lower some internal chain nodes to exactly the sum of their children.
  const changes: { id: number; error: number }[] = [];
  let treeIndex = 0;
  for (const root of forest) {
    if (treeIndex % 2 === 0) {
      changes.push({ id: root.id, error: root.error + 500 });
    }
    const chainChild = root.children![root.children!.length - 1]!;
    changes.push({ id: chainChild.id, error: sumOfChildrenErrors(chainChild) });
    treeIndex++;
  }
  planner.updateErrors(changes);
  applyChanges(forest, changes);

  const second = planner.plan();
  checkInvariants(second);

  // No updates: the cut must be reproduced exactly.
  const third = planner.plan();
  assert.equal(third.switches, 0);
  assert.deepEqual(new Set(third.selected), new Set(second.selected));
  assert.equal(third.totalError, second.totalError);
});

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("randomized forests match brute force across update rounds", () => {
  const rand = lcg(20261007);
  const pick = (n: number) => Math.floor(rand() * n);

  for (let trial = 0; trial < 100; trial++) {
    // Small random forest: 1-4 roots, depth <= 4, fan-out <= 2.
    let nextId = 1;
    const buildTree = (depth: number): ForestNodeInput => {
      const node: ForestNodeInput = { id: nextId++, error: 0 };
      if (depth < 4 && rand() < 0.7) {
        const childCount = 1 + pick(2);
        node.children = [];
        for (let i = 0; i < childCount; i++) node.children.push(buildTree(depth + 1));
      }
      return node;
    };
    const forest: ForestNodeInput[] = [];
    const rootCount = 1 + pick(4);
    for (let r = 0; r < rootCount; r++) forest.push(buildTree(1));
    // Random valid errors: internal = sum(children) + small extra.
    const assign = (node: ForestNodeInput): number => {
      const children = node.children ?? [];
      if (children.length === 0) {
        node.error = 0;
        return 0;
      }
      let sum = 0;
      for (const child of children) sum += assign(child);
      node.error = sum + pick(6);
      return node.error;
    };
    for (const root of forest) assign(root);

    const byId = new Map<number, ForestNodeInput>();
    const parents = new Map<number, ForestNodeInput>();
    const collect = (node: ForestNodeInput, parent?: ForestNodeInput): void => {
      byId.set(node.id, node);
      if (parent) parents.set(node.id, parent);
      for (const child of node.children ?? []) collect(child, node);
    };
    for (const root of forest) collect(root);

    const budget = rootCount + pick(10);
    const planner = createChunkPlanner(forest, budget);
    let previousCut = new Set<number>(forest.map((root) => root.id));

    for (let round = 0; round < 6; round++) {
      if (round > 0) {
        // Random updates that preserve every numeric invariant.
        const changes: { id: number; error: number }[] = [];
        for (const [id, node] of byId) {
          if (rand() < 0.4) continue;
          const children = node.children ?? [];
          if (children.length === 0) continue; // leaves stay 0
          const sumChildren = children.reduce((acc, child) => acc + child.error, 0);
          const parent = parents.get(id);
          const siblingSum = parent
            ? (parent.children ?? []).reduce((acc, child) => acc + child.error, 0) - node.error
            : 0;
          const upper = parent ? parent.error - siblingSum : sumChildren + 30;
          if (upper < sumChildren) continue; // cannot happen for valid state
          const error = sumChildren + pick(upper - sumChildren + 1);
          // Apply immediately so later bounds see the evolving forest state.
          node.error = error;
          changes.push({ id, error });
        }
        planner.updateErrors(changes);
      }
      const result = planner.plan();
      const reference = referencePlan(forest, budget, previousCut);
      assert.equal(result.totalError, reference.totalError, `trial ${trial} round ${round} loss`);
      assert.equal(result.switches, reference.switches, `trial ${trial} round ${round} switches`);
      assert.ok(result.selected.length <= budget);
      assertExactCover(forest, new Set(result.selected));
      previousCut = new Set(result.selected);
    }
  }
});
