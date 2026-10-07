/** 一个模块条目：稳定身份 + 内容版本（由上层提供）。 */
export interface ModuleSpec {
  moduleId: string;
  contentVersion: string;
}

/** 发布修订的输入。 */
export interface PublishRevisionInput {
  modules: ModuleSpec[];
  passPercent: number;
}

/** 一条测验成绩。 */
export interface QuizAttempt {
  attemptId: string;
  learnerId: string;
  moduleId: string;
  contentVersion: string;
  correct: number;
  total: number;
}

/** 当前进度中单个模块的达标情况。 */
export interface ModuleProgress {
  moduleId: string;
  contentVersion: string;
  passed: boolean;
}

/** 学习者相对当前修订的进度。 */
export interface LearnerProgress {
  learnerId: string;
  revisionId: number | null;
  modules: ModuleProgress[];
  allPassed: boolean;
}

/** 一枚历史徽章。 */
export interface Badge {
  learnerId: string;
  revisionId: number;
  grantedAt: string;
}

/** 发布修订的结果。 */
export interface PublishResult {
  revisionId: number;
}

/** 接收成绩的结果。 */
export interface SubmitResult {
  /** 是否为首次收到该答题编号（false 表示重复提交被忽略）。 */
  accepted: boolean;
}
