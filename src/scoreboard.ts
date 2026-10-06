import { ValidationError } from "./errors.ts";
import { CATEGORY_COUNT, WEIGHT_TOTAL } from "./types.ts";
import type {
  CategoryId,
  MemberId,
  MemberView,
  ScoreSet,
  TeamView,
  WeightSet,
} from "./types.ts";

export interface ScoreBoardInit {
  /** 固定类别顺序，长度必须为 10 */
  categories: readonly CategoryId[];
  /** 初始权重，长度 10，正整数，总和 10000 */
  weights: WeightSet;
  /** 紧邻上一周期的综合分；成员可缺失，缺失不算连续低分 */
  previousComposites?: ReadonlyMap<MemberId, number>;
}

export interface ScoreBoard {
  /** 批量录入或修订成员的完整评分；同一批次全部同时生效，任一非法则整批拒绝 */
  submitScores(entries: ReadonlyMap<MemberId, ScoreSet>): void;
  /** 替换当前周期权重；完成时一次性发布 */
  replaceWeights(weights: WeightSet): void;
  /** 团队均分与已评分人数 */
  teamView(): TeamView;
  /** 指定成员的综合分、百分位、辅导资格与目标类别；未评分成员返回 null */
  memberView(member: MemberId): MemberView | null;
}

/** 综合分放大 10000 倍后的整数，排名与资格判断用它避免浮点误差 */
const ELIGIBILITY_THRESHOLD_SCALED = 3.0 * WEIGHT_TOTAL;

function validateWeights(weights: WeightSet): void {
  if (!Array.isArray(weights) || weights.length !== CATEGORY_COUNT) {
    throw new ValidationError(
      `weights must contain exactly ${CATEGORY_COUNT} entries`,
    );
  }
  let sum = 0;
  for (const w of weights) {
    if (!Number.isInteger(w) || w <= 0) {
      throw new ValidationError(`each weight must be a positive integer, got ${w}`);
    }
    sum += w;
  }
  if (sum !== WEIGHT_TOTAL) {
    throw new ValidationError(`weights must sum to ${WEIGHT_TOTAL}, got ${sum}`);
  }
}

function validateScoreSet(scores: ScoreSet): void {
  if (!Array.isArray(scores) || scores.length !== CATEGORY_COUNT) {
    throw new ValidationError(
      `each score set must contain exactly ${CATEGORY_COUNT} entries`,
    );
  }
  for (const s of scores) {
    if (!Number.isInteger(s) || s < 1 || s > 5) {
      throw new ValidationError(`each score must be an integer in 1..5, got ${s}`);
    }
  }
}

export function createScoreBoard(init: ScoreBoardInit): ScoreBoard {
  if (!Array.isArray(init.categories) || init.categories.length !== CATEGORY_COUNT) {
    throw new ValidationError(
      `categories must contain exactly ${CATEGORY_COUNT} entries`,
    );
  }
  const categories = init.categories.map((c) => {
    if (typeof c !== "string" || c.length === 0) {
      throw new ValidationError("each category must be a non-empty string");
    }
    return c;
  });
  if (new Set(categories).size !== CATEGORY_COUNT) {
    throw new ValidationError("categories must be unique");
  }
  validateWeights(init.weights);

  const previous = new Map<MemberId, number>();
  if (init.previousComposites) {
    for (const [member, value] of init.previousComposites) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ValidationError(
          `previous composite for ${member} must be a finite number`,
        );
      }
      previous.set(member, value);
    }
  }

  // 可变状态：权重整体替换、评分整批替换，派生数据查询时从原始状态现算，
  // 因此任何一次查询都不会混用不同版本的权重或评分。
  let weights: readonly number[] = [...init.weights];
  const scores = new Map<MemberId, readonly number[]>();

  function scaledComposite(scoreSet: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < CATEGORY_COUNT; i++) {
      sum += scoreSet[i] * weights[i];
    }
    return sum;
  }

  return {
    submitScores(entries: ReadonlyMap<MemberId, ScoreSet>): void {
      // 先整批校验，再整批生效，保证同一批次不会部分生效
      const staged: [MemberId, readonly number[]][] = [];
      for (const [member, scoreSet] of entries) {
        validateScoreSet(scoreSet);
        staged.push([member, [...scoreSet]]);
      }
      for (const [member, scoreSet] of staged) {
        scores.set(member, scoreSet);
      }
    },

    replaceWeights(next: WeightSet): void {
      validateWeights(next);
      weights = [...next];
    },

    teamView(): TeamView {
      let total = 0;
      for (const scoreSet of scores.values()) {
        total += scaledComposite(scoreSet);
      }
      return {
        scoredCount: scores.size,
        average:
          scores.size === 0 ? null : total / (scores.size * WEIGHT_TOTAL),
      };
    },

    memberView(member: MemberId): MemberView | null {
      const own = scores.get(member);
      if (!own) return null;
      const ownScaled = scaledComposite(own);

      let below = 0;
      let equal = 0;
      for (const scoreSet of scores.values()) {
        const scaled = scaledComposite(scoreSet);
        if (scaled < ownScaled) below++;
        else if (scaled === ownScaled) equal++;
      }
      const percentile = (100 * (below + equal / 2)) / scores.size;

      const prev = previous.get(member);
      const coachingEligible =
        prev !== undefined &&
        prev < 3.0 &&
        ownScaled < ELIGIBILITY_THRESHOLD_SCALED;

      const coachingTargets: CategoryId[] = [];
      if (coachingEligible) {
        const order = own
          .map((score, index) => ({ score, index }))
          .sort((a, b) => a.score - b.score || a.index - b.index);
        coachingTargets.push(categories[order[0].index], categories[order[1].index]);
      }

      return {
        composite: ownScaled / WEIGHT_TOTAL,
        percentile,
        coachingEligible,
        coachingTargets,
      };
    },
  };
}
