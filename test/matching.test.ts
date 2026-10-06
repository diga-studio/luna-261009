import test from "node:test";
import assert from "node:assert/strict";
import { maxWeightMatching } from "../src/matching";

test("picks the globally better assignment over a greedy one", () => {
  // a0 can do s0 (w=5) or s1 (w=4); a1 can only do s0 (w=4).
  // Greedy on a0 would take s0 and leave s1 uncovered; optimum is 4+4=8? No:
  // optimum is a0->s1 (4) + a1->s0 (4) = 8 vs a0->s0 (5) alone = 5.
  const r = maxWeightMatching(2, 2, [
    { actionIndex: 0, stepIndex: 0, weight: 5 },
    { actionIndex: 0, stepIndex: 1, weight: 4 },
    { actionIndex: 1, stepIndex: 0, weight: 4 },
  ]);
  assert.equal(r.totalWeight, 8);
  assert.equal(r.pairs.get(0), 1);
  assert.equal(r.pairs.get(1), 0);
});

test("handles more actions than steps and ignores useless edges", () => {
  const r = maxWeightMatching(3, 1, [
    { actionIndex: 0, stepIndex: 0, weight: 2 },
    { actionIndex: 1, stepIndex: 0, weight: 9 },
  ]);
  assert.equal(r.totalWeight, 9);
  assert.equal(r.pairs.get(1), 0);
  assert.equal(r.pairs.size, 1);
});

test("empty inputs", () => {
  assert.deepEqual(maxWeightMatching(0, 3, []).totalWeight, 0);
  assert.deepEqual(maxWeightMatching(3, 0, []).pairs.size, 0);
});
