/** 模块描述：稳定身份 + 上层提供的内容版本。 */
export interface ModuleSpec {
  moduleId: string;
  contentVersion: string;
}

/** 一条测验成绩。attemptId 全局唯一，同一编号内容不变。 */
export interface ScoreSubmission {
  learnerId: string;
  attemptId: string;
  moduleId: string;
  contentVersion: string;
  correct: number;
  total: number;
}

/** 当前修订中单个模块的达标状态。 */
export interface ModuleProgress {
  moduleId: string;
  contentVersion: string;
  passed: boolean;
}

/** 学习者相对当前修订的进度快照。 */
export interface ProgressSnapshot {
  revisionId: number;
  passPercent: number;
  modules: ModuleProgress[];
  allPassed: boolean;
  /** 当前修订的徽章是否已授予。 */
  currentBadgeEarned: boolean;
}

/** 一枚历史徽章（含当前修订，若已授予）。 */
export interface Badge {
  revisionId: number;
  earnedAt: string;
}

/** 发布修订的返回结果。 */
export interface PublishResult {
  revisionId: number;
}

/** 成绩接收的返回结果。 */
export interface SubmitResult {
  /** 是否为首次接收（重复提交为 false，不计入第二次）。 */
  accepted: boolean;
}
