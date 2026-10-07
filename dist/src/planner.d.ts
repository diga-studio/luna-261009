export declare const DEFAULT_BUDGET = 200;
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
export declare function createChunkPlanner(forest: ForestNodeInput[], budget?: number): ChunkPlanner;
