/** 词库中的一个词条。 */
export interface WordEntry {
  /** 稳定标识，词库内唯一。 */
  readonly id: string;
  /** 原词。 */
  readonly word: string;
  /** 译文，按精确字符串比较。 */
  readonly translation: string;
  /** 行业标签，按精确字符串比较。 */
  readonly industry: string;
  /** 难度，1 至 5 的整数。 */
  readonly difficulty: number;
}

/** 试卷中的一道四选一题目。 */
export interface QuizQuestion {
  /** 题干词条的稳定标识。 */
  readonly stemId: string;
  /** 题干原词。 */
  readonly word: string;
  /** 4 个译文选项，包含正确译文，顺序已打乱（确定性）。 */
  readonly options: readonly string[];
  /** 正确译文（题干的译文）。 */
  readonly correctAnswer: string;
}

/** 组卷成功结果。 */
export interface ExamSuccess {
  readonly ok: true;
  /** 恰好 20 道题，顺序与调用方给出的题干顺序一致。 */
  readonly questions: readonly QuizQuestion[];
  /** 整卷总难度差：60 个干扰词条与各自题干难度差绝对值之和。 */
  readonly totalDifficultyGap: number;
}

/** 组卷失败结果：整张试卷不存在合法分配。 */
export interface ExamFailure {
  readonly ok: false;
  readonly reason: string;
}

export type ExamResult = ExamSuccess | ExamFailure;
