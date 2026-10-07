/** A single immutable input record. */
export interface EntityRecord {
  readonly id: string;
  readonly title: string;
  readonly address: string;
  readonly lat: number;
  readonly lon: number;
}

/** Result of a cluster() call. */
export interface ClusterResult {
  /** Partition of all input records; singletons included. Deterministically ordered. */
  readonly clusters: readonly EntityRecord[][];
  /** Number of edit-distance computations actually initiated during cluster(). */
  readonly distanceEvaluations: number;
}
