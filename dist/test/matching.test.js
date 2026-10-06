"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const matching_1 = require("../src/matching");
(0, node_test_1.default)("picks the globally better assignment over a greedy one", () => {
    // a0 can do s0 (w=5) or s1 (w=4); a1 can only do s0 (w=4).
    // Greedy on a0 would take s0 and leave s1 uncovered; optimum is 4+4=8? No:
    // optimum is a0->s1 (4) + a1->s0 (4) = 8 vs a0->s0 (5) alone = 5.
    const r = (0, matching_1.maxWeightMatching)(2, 2, [
        { actionIndex: 0, stepIndex: 0, weight: 5 },
        { actionIndex: 0, stepIndex: 1, weight: 4 },
        { actionIndex: 1, stepIndex: 0, weight: 4 },
    ]);
    strict_1.default.equal(r.totalWeight, 8);
    strict_1.default.equal(r.pairs.get(0), 1);
    strict_1.default.equal(r.pairs.get(1), 0);
});
(0, node_test_1.default)("handles more actions than steps and ignores useless edges", () => {
    const r = (0, matching_1.maxWeightMatching)(3, 1, [
        { actionIndex: 0, stepIndex: 0, weight: 2 },
        { actionIndex: 1, stepIndex: 0, weight: 9 },
    ]);
    strict_1.default.equal(r.totalWeight, 9);
    strict_1.default.equal(r.pairs.get(1), 0);
    strict_1.default.equal(r.pairs.size, 1);
});
(0, node_test_1.default)("empty inputs", () => {
    strict_1.default.deepEqual((0, matching_1.maxWeightMatching)(0, 3, []).totalWeight, 0);
    strict_1.default.deepEqual((0, matching_1.maxWeightMatching)(3, 0, []).pairs.size, 0);
});
