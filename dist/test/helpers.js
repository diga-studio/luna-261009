"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allIds = exports.assertExactCover = exports.referencePlan = exports.errorOf = exports.enumerateCuts = exports.applyChanges = void 0;
const strict_1 = __importDefault(require("node:assert/strict"));
/** Applies error changes to a forest input in place (mirrors updateErrors). */
function applyChanges(forest, changes) {
    const byId = new Map();
    const walk = (node) => {
        byId.set(node.id, node);
        for (const child of node.children ?? [])
            walk(child);
    };
    for (const root of forest)
        walk(root);
    for (const change of changes) {
        const node = byId.get(change.id);
        strict_1.default.ok(node, `unknown node id ${change.id}`);
        node.error = change.error;
    }
}
exports.applyChanges = applyChanges;
/** All legal cuts of a single tree: {root} or the union of child cuts. */
function enumerateTreeCuts(node) {
    const children = node.children ?? [];
    if (children.length === 0)
        return [[node.id]];
    let combos = [[]];
    for (const child of children) {
        const childCuts = enumerateTreeCuts(child);
        const next = [];
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
/** Every legal cut of the forest (cartesian product over trees). */
function enumerateCuts(forest) {
    let combos = [[]];
    for (const root of forest) {
        const treeCuts = enumerateTreeCuts(root);
        const next = [];
        for (const prefix of combos) {
            for (const cut of treeCuts) {
                next.push(prefix.concat(cut));
            }
        }
        combos = next;
    }
    return combos;
}
exports.enumerateCuts = enumerateCuts;
function errorOf(forest) {
    const map = new Map();
    const walk = (node) => {
        map.set(node.id, node.error);
        for (const child of node.children ?? [])
            walk(child);
    };
    for (const root of forest)
        walk(root);
    return map;
}
exports.errorOf = errorOf;
/**
 * Independent brute-force optimum: among all legal cuts within budget, the
 * exact minimum total error, tie-broken by minimum switch count vs prevCut.
 */
function referencePlan(forest, budget, prevCut) {
    const errors = errorOf(forest);
    let bestError = Infinity;
    let bestSwitches = Infinity;
    let best = [];
    for (const cut of enumerateCuts(forest)) {
        if (cut.length > budget)
            continue;
        let totalError = 0;
        let overlap = 0;
        for (const id of cut) {
            totalError += errors.get(id);
            if (prevCut.has(id))
                overlap++;
        }
        const switches = prevCut.size + cut.length - 2 * overlap;
        if (totalError < bestError || (totalError === bestError && switches < bestSwitches)) {
            bestError = totalError;
            bestSwitches = switches;
            best = cut;
        }
    }
    return { totalError: bestError, switches: bestSwitches, selected: new Set(best) };
}
exports.referencePlan = referencePlan;
/** Asserts every root-to-leaf path contains exactly one selected node. */
function assertExactCover(forest, selected) {
    const walk = (node, selectedOnPath) => {
        const here = selectedOnPath + (selected.has(node.id) ? 1 : 0);
        strict_1.default.ok(here <= 1, `node ${node.id} selected together with an ancestor`);
        const children = node.children ?? [];
        if (children.length === 0) {
            strict_1.default.equal(here, 1, `leaf ${node.id} is not covered exactly once`);
            return;
        }
        for (const child of children)
            walk(child, here);
    };
    for (const root of forest)
        walk(root, 0);
}
exports.assertExactCover = assertExactCover;
/** All node ids of the forest. */
function allIds(forest) {
    return [...errorOf(forest).keys()];
}
exports.allIds = allIds;
