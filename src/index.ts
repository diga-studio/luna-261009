import {
  CATEGORY_COUNT,
  COACHING_THRESHOLD,
  WEIGHT_TOTAL,
} from "./types.js";
import type {
  CategoryWeight,
  MemberResult,
  MemberScores,
  ScoringConfig,
  TeamSnapshot,
} from "./types.js";

export * from "./types.js";

declare function setImmediate(callback: () => void): void;

function validateWeights(weights: readonly CategoryWeight[]): void {
  if (!Array.isArray(weights) || weights.length !== CATEGORY_COUNT) {
    throw new Error(`weights must have exactly ${CATEGORY_COUNT} entries`);
  }
  let sum = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w <= 0) {
      throw new Error("each weight must be a positive integer");
    }
    sum += w;
  }
  if (sum !== WEIGHT_TOTAL) {
    throw new Error(`weights must sum to ${WEIGHT_TOTAL}, got ${sum}`);
  }
}

function validateScores(memberId: string, scores: readonly number[]): void {
  if (typeof memberId !== "string" || memberId.length === 0) {
    throw new Error("memberId must be a non-empty string");
  }
  if (!Array.isArray(scores) || scores.length !== CATEGORY_COUNT) {
    throw new Error(
      `scores for member "${memberId}" must have exactly ${CATEGORY_COUNT} entries`,
    );
  }
  for (const s of scores) {
    if (!Number.isInteger(s) || s < 1 || s > 5) {
      throw new Error(
        `scores for member "${memberId}" must be integers between 1 and 5`,
      );
    }
  }
}

/** Pure full recomputation of the derived view from raw inputs. */
function computeSnapshot(
  categories: readonly string[],
  weights: readonly CategoryWeight[],
  scores: ReadonlyMap<string, readonly number[]>,
  previous: Readonly<Record<string, number>>,
): TeamSnapshot {
  const composites = new Map<string, number>();
  for (const [memberId, memberScores] of scores) {
    let weighted = 0;
    for (let i = 0; i < CATEGORY_COUNT; i++) {
      weighted += memberScores[i] * weights[i];
    }
    composites.set(memberId, weighted / WEIGHT_TOTAL);
  }

  const total = composites.size;
  let teamAverage: number | null = null;
  if (total > 0) {
    let sum = 0;
    for (const c of composites.values()) sum += c;
    teamAverage = sum / total;
  }

  const members = new Map<string, MemberResult>();
  for (const [memberId, composite] of composites) {
    let below = 0;
    let equal = 0;
    for (const other of composites.values()) {
      if (other < composite) below++;
      else if (other === composite) equal++;
    }
    const percentile = (100 * (below + equal / 2)) / total;

    const prev = previous[memberId];
    const coachingEligible =
      prev !== undefined &&
      prev < COACHING_THRESHOLD &&
      composite < COACHING_THRESHOLD;

    let coachingTargets: string[] = [];
    if (coachingEligible) {
      const memberScores = scores.get(memberId)!;
      const order = memberScores
        .map((score, index) => ({ score, index }))
        .sort((a, b) => a.score - b.score || a.index - b.index);
      coachingTargets = [categories[order[0].index], categories[order[1].index]];
    }

    members.set(memberId, {
      memberId,
      composite,
      percentile,
      coachingEligible,
      coachingTargets,
    });
  }

  return { teamAverage, members };
}

/**
 * In-memory scoring engine for one team, current period only.
 * Queries always read a single immutable snapshot; recalculations
 * publish atomically, so results never mix old and new weights.
 */
export class ScoringEngine {
  private readonly categories: readonly string[];
  private readonly previous: Readonly<Record<string, number>>;
  private readonly scores = new Map<string, readonly number[]>();
  private weights: readonly CategoryWeight[];
  private snapshot: TeamSnapshot;
  private dataVersion = 0;
  private recalcChain: Promise<void> = Promise.resolve();

  constructor(config: ScoringConfig) {
    if (
      !config ||
      !Array.isArray(config.categories) ||
      config.categories.length !== CATEGORY_COUNT ||
      config.categories.some((c) => typeof c !== "string" || c.length === 0)
    ) {
      throw new Error(
        `categories must be ${CATEGORY_COUNT} non-empty strings in fixed order`,
      );
    }
    validateWeights(config.weights);
    const previous: Record<string, number> = {};
    if (config.previousComposites) {
      for (const [id, value] of Object.entries(config.previousComposites)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`previous composite for "${id}" must be a number`);
        }
        previous[id] = value;
      }
    }
    this.categories = Object.freeze([...config.categories]);
    this.previous = Object.freeze(previous);
    this.weights = Object.freeze([...config.weights]);
    this.snapshot = computeSnapshot(
      this.categories,
      this.weights,
      this.scores,
      this.previous,
    );
  }

  /** Batch record/revise full 10-category scores. All-or-nothing. */
  submitScores(batch: MemberScores[]): void {
    if (!Array.isArray(batch)) {
      throw new Error("batch must be an array");
    }
    const seen = new Set<string>();
    for (const entry of batch) {
      validateScores(entry?.memberId, entry?.scores);
      if (seen.has(entry.memberId)) {
        throw new Error(`duplicate member "${entry.memberId}" in batch`);
      }
      seen.add(entry.memberId);
    }
    for (const entry of batch) {
      this.scores.set(entry.memberId, Object.freeze([...entry.scores]));
    }
    this.dataVersion++;
    this.snapshot = computeSnapshot(
      this.categories,
      this.weights,
      this.scores,
      this.previous,
    );
  }

  /**
   * Replace weights. Old weights keep serving queries until the
   * recalculation completes; the promise resolves when the new
   * weights are published. Revisions committed while a recalculation
   * is in flight are picked up before publishing, so they never get lost.
   */
  replaceWeights(weights: CategoryWeight[]): Promise<void> {
    validateWeights(weights);
    const next = Object.freeze([...weights]);
    const published = this.recalcChain.then(() => this.publishWeights(next));
    this.recalcChain = published.catch(() => {});
    return published;
  }

  private async publishWeights(
    weights: readonly CategoryWeight[],
  ): Promise<void> {
    let version: number;
    let snapshot: TeamSnapshot;
    do {
      version = this.dataVersion;
      await new Promise<void>((resolve) => setImmediate(resolve));
      snapshot = computeSnapshot(
        this.categories,
        weights,
        this.scores,
        this.previous,
      );
    } while (version !== this.dataVersion);
    this.weights = weights;
    this.snapshot = snapshot;
  }

  /** Current weights in effect (1 unit = 0.01pp). */
  getWeights(): readonly CategoryWeight[] {
    return this.weights;
  }

  /** Average composite of scored members; null when none scored. */
  getTeamAverage(): number | null {
    return this.snapshot.teamAverage;
  }

  /** Composite, percentile, coaching eligibility and targets for one member. */
  getMemberResult(memberId: string): MemberResult | null {
    return this.snapshot.members.get(memberId) ?? null;
  }

  /** Full immutable snapshot of the current derived state. */
  getSnapshot(): TeamSnapshot {
    return this.snapshot;
  }
}
