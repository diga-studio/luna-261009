/** 词库中的一个词条。 */
export interface WordEntry {
  /** 稳定标识 */
  id: string;
  /** 原词 */
  word: string;
  /** 译文 */
  translation: string;
  /** 行业标签（精确字符串比较） */
  tag: string;
  /** 难度，1 至 5 */
  difficulty: number;
}

/** 试卷中的一道四选一题目。 */
export interface QuizQuestion {
  /** 题干词条 */
  stem: WordEntry;
  /** 4 个译文选项，互不相同，其中之一为正确译文 */
  options: [string, string, string, string];
  /** 正确译文在 options 中的下标 */
  correctIndex: number;
  /** 本题使用的 3 个干扰词条 */
  distractors: [WordEntry, WordEntry, WordEntry];
}

/** 组卷成功结果。 */
export interface PaperSuccess {
  ok: true;
  /** 恰好 20 题，与调用方给定的题干一一对应 */
  questions: QuizQuestion[];
  /** 60 个干扰词条与各自题干的难度差绝对值之和 */
  totalDifficultyGap: number;
}

/** 组卷失败结果：整张试卷不存在合法分配。 */
export interface PaperFailure {
  ok: false;
  reason: string;
}

export type PaperResult = PaperSuccess | PaperFailure;
