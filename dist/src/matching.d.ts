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
export declare function maxWeightMatching(actionCount: number, stepCount: number, edges: MatchingEdge[]): MatchingResult;
