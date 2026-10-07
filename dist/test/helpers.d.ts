import { ErrorChange, ForestNodeInput } from "../src/planner";
/** Applies error changes to a forest input in place (mirrors updateErrors). */
export declare function applyChanges(forest: ForestNodeInput[], changes: ErrorChange[]): void;
export interface CutInfo {
    ids: number[];
    totalError: number;
}
/** Every legal cut of the forest (cartesian product over trees). */
export declare function enumerateCuts(forest: ForestNodeInput[]): number[][];
export declare function errorOf(forest: ForestNodeInput[]): Map<number, number>;
export interface ReferenceResult {
    totalError: number;
    switches: number;
    selected: Set<number>;
}
/**
 * Independent brute-force optimum: among all legal cuts within budget, the
 * exact minimum total error, tie-broken by minimum switch count vs prevCut.
 */
export declare function referencePlan(forest: ForestNodeInput[], budget: number, prevCut: ReadonlySet<number>): ReferenceResult;
/** Asserts every root-to-leaf path contains exactly one selected node. */
export declare function assertExactCover(forest: ForestNodeInput[], selected: ReadonlySet<number>): void;
/** All node ids of the forest. */
export declare function allIds(forest: ForestNodeInput[]): number[];
