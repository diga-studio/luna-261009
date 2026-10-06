/** Number of scoring categories. Fixed. */
export const CATEGORY_COUNT = 10;

/** Sum all weights must equal. 1 weight unit = 0.01 percentage point. */
export const WEIGHT_TOTAL = 10000;

/** Coaching eligibility threshold: both periods must be strictly below this. */
export const COACHING_THRESHOLD = 3.0;

/** Integer score for one category, 1..5. */
export type CategoryScore = number;

/** Weight for one category: positive integer, 1 unit = 0.01pp. */
export type CategoryWeight = number;

/** Full 10-category score entry for one member (batch record/revise). */
export interface MemberScores {
  memberId: string;
  /** Scores in the fixed caller-provided category order. Length must be CATEGORY_COUNT. */
  scores: CategoryScore[];
}

/** Per-member computed view for the current period. */
export interface MemberResult {
  memberId: string;
  /** Weighted composite, unrounded. */
  composite: number;
  /** 0..100. 50 when alone or all tied. */
  percentile: number;
  /** True only when previous and current composites are both strictly below 3.0. */
  coachingEligible: boolean;
  /** The two lowest-scored categories (ties by fixed category order). Empty unless eligible. */
  coachingTargets: string[];
}

/** Immutable derived snapshot; queries never mix data across snapshots. */
export interface TeamSnapshot {
  /** Average composite over scored members; null when nobody is scored. */
  teamAverage: number | null;
  /** Results keyed by member id; only scored members present. */
  members: ReadonlyMap<string, MemberResult>;
}

/** Configuration supplied by the caller at construction time. */
export interface ScoringConfig {
  /** Fixed category order, exactly CATEGORY_COUNT entries. */
  categories: string[];
  /** Initial weights, positive integers summing to WEIGHT_TOTAL. */
  weights: CategoryWeight[];
  /** Previous-period composites by member id; may be absent; never mutated. */
  previousComposites?: Readonly<Record<string, number>>;
}
