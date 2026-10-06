/** 类别数量固定为 10 */
export const CATEGORY_COUNT = 10;

/** 权重单位：1 单位 = 0.01 个百分点，10 项之和必须为 10000 */
export const WEIGHT_TOTAL = 10000;

/** 类别标识，顺序由调用方提供且不变 */
export type CategoryId = string;

/** 成员标识 */
export type MemberId = string;

/** 一个成员的完整评分：长度 10，每项为 1..5 的整数，顺序与类别顺序一致 */
export type ScoreSet = readonly number[];

/** 权重：长度 10，正整数，总和 10000 */
export type WeightSet = readonly number[];

/** 指定成员的查询结果 */
export interface MemberView {
  /** 综合分（未四舍五入） */
  composite: number;
  /** 百分位 0..100 */
  percentile: number;
  /** 是否具备辅导资格 */
  coachingEligible: boolean;
  /** 具备资格时的目标类别（按固定类别顺序取原始评分最低的两个）；不具备资格时为空数组 */
  coachingTargets: CategoryId[];
}

/** 团队视图 */
export interface TeamView {
  /** 已评分成员数 */
  scoredCount: number;
  /** 团队均分（未四舍五入）；无已评分成员时为 null */
  average: number | null;
}
