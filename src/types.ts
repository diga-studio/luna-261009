/**
 * 纪律状态。数值即状态机内部编码，勿改动顺序。
 */
export enum DisciplineState {
  /** 无处分 */
  None = 0,
  /** 审查中 */
  Review = 1,
  /** 处分中 */
  Punishment = 2,
  /** 已解决 */
  Resolved = 3,
}

/** 处罚编号，字符串或整数均可，实例内唯一。 */
export type PenaltyId = string | number;

/**
 * 一条已批准且会触发纪律处理的处罚。
 * 有效区间为 [start, end)，整数 UTC 秒，必须落在周期窗口内。
 */
export interface Penalty {
  readonly id: PenaltyId;
  readonly start: number;
  readonly end: number;
}

/**
 * 一条人工状态指令。
 * time 为生效时间（整数 UTC 秒，落在周期内），seq 为唯一整数序号，
 * 同一秒内的指令按 seq 升序处理。
 */
export interface Directive {
  readonly time: number;
  readonly seq: number;
  readonly target: DisciplineState;
}

/** 周期完整资料。装载后不再新增，只可撤销处罚。 */
export interface PeriodDossier {
  readonly penalties: readonly Penalty[];
  readonly directives: readonly Directive[];
}
