import { MinCostFlow } from './minCostFlow';
import type { ExamResult, QuizQuestion, WordEntry } from './types';

/** 每场试卷的固定题数。 */
export const QUESTIONS_PER_EXAM = 20;
/** 每题的选项数（1 个正确译文 + 3 个干扰译文）。 */
export const OPTIONS_PER_QUESTION = 4;
/** 同一译文作为干扰项在整卷中的配额上限。 */
export const TRANSLATION_DISTRACTOR_QUOTA = 2;
/** 干扰项与题干允许的最大难度差。 */
export const MAX_DIFFICULTY_GAP = 1;

const DISTRACTORS_PER_QUESTION = OPTIONS_PER_QUESTION - 1;

/**
 * 词汇测验组卷库。一次处理一个语种的词库，数据保存在内存中。
 *
 * 组卷建模为最小费用流：
 * 源点 -> 题目（容量 3）-> 「题目 × 译文」配对点（容量 1，保证同题译文互异）
 * -> 词条（容量 1，整卷最多用一次）-> 译文（容量 2，整卷干扰项配额）-> 汇点。
 * 配对点 -> 词条的边费用为难度差绝对值，故最小费用即整卷最小总难度差。
 */
export class ExamBuilder {
  private readonly entries = new Map<string, WordEntry>();

  /** 载入（替换）整个词库。词条非法时抛出 Error。 */
  loadEntries(entries: readonly WordEntry[]): void {
    const next = new Map<string, WordEntry>();
    for (const entry of entries) {
      validateEntry(entry);
      if (next.has(entry.id)) {
        throw new Error(`duplicate entry id: ${entry.id}`);
      }
      next.set(entry.id, entry);
    }
    this.entries.clear();
    for (const [id, entry] of next) this.entries.set(id, entry);
  }

  /**
   * 为指定的 20 个题干词条生成试卷。
   * 输入非法（数量不为 20、重复或未知标识）时抛出 Error；
   * 仅在整卷不存在合法分配时返回 { ok: false }。
   */
  generateExam(stemIds: readonly string[]): ExamResult {
    const stems = this.resolveStems(stemIds);
    const stemIdSet = new Set(stemIds);

    // 候选词条：排除全部题干词条。
    const candidates = [...this.entries.values()].filter((e) => !stemIdSet.has(e.id));

    // 每题的合格干扰词条：同行业、难度差不超过 1、译文不等于正确译文。
    const compatible: WordEntry[][] = stems.map((stem) =>
      candidates.filter(
        (entry) =>
          entry.industry === stem.industry &&
          Math.abs(entry.difficulty - stem.difficulty) <= MAX_DIFFICULTY_GAP &&
          entry.translation !== stem.translation,
      ),
    );

    // 节点编号布局：0=源点，之后依次是题目、配对点、词条、译文、汇点。
    const source = 0;
    let nextNode = 1;
    const questionNode = stems.map(() => nextNode++);
    // 每个题目 x 每个可用译文 一个配对点（保证同一题目内译文互异）。
    const pairNodeByQuestion: Map<string, number>[] = compatible.map((entries) => {
      const pairs = new Map<string, number>();
      for (const entry of entries) {
        if (!pairs.has(entry.translation)) pairs.set(entry.translation, nextNode++);
      }
      return pairs;
    });
    const entryNode = new Map<string, number>();
    for (const entry of candidates) entryNode.set(entry.id, nextNode++);
    const translationNode = new Map<string, number>();
    for (const entry of candidates) {
      if (!translationNode.has(entry.translation)) {
        translationNode.set(entry.translation, nextNode++);
      }
    }
    const sink = nextNode++;

    const flow = new MinCostFlow(nextNode);
    for (const qn of questionNode) {
      flow.addEdge(source, qn, DISTRACTORS_PER_QUESTION, 0);
    }
    stems.forEach((_, qi) => {
      for (const pairNode of pairNodeByQuestion[qi]!.values()) {
        flow.addEdge(questionNode[qi]!, pairNode, 1, 0);
      }
    });
    // 配对点 -> 词条：记录这些边以便回读分配结果。
    const assignmentEdges: { question: number; entryId: string; edgeIndex: number }[] = [];
    stems.forEach((stem, qi) => {
      for (const entry of compatible[qi]!) {
        const pairNode = pairNodeByQuestion[qi]!.get(entry.translation)!;
        const edgeIndex = flow.addEdge(
          pairNode,
          entryNode.get(entry.id)!,
          1,
          Math.abs(entry.difficulty - stem.difficulty),
        );
        assignmentEdges.push({ question: qi, entryId: entry.id, edgeIndex });
      }
    });
    for (const entry of candidates) {
      flow.addEdge(entryNode.get(entry.id)!, translationNode.get(entry.translation)!, 1, 0);
    }
    for (const node of translationNode.values()) {
      flow.addEdge(node, sink, TRANSLATION_DISTRACTOR_QUOTA, 0);
    }

    const required = stems.length * DISTRACTORS_PER_QUESTION;
    const result = flow.solve(source, sink, required);
    if (result.flow < required) {
      return { ok: false, reason: '整张试卷不存在满足全部规则的干扰项分配' };
    }

    // 回读分配：每题 3 个干扰词条。
    const chosen: WordEntry[][] = stems.map(() => []);
    for (const { question, entryId, edgeIndex } of assignmentEdges) {
      if (result.edgeFlows[edgeIndex] === 1) {
        chosen[question]!.push(this.entries.get(entryId)!);
      }
    }

    const questions: QuizQuestion[] = stems.map((stem, qi) => {
      const distractors = chosen[qi]!;
      // 确定性打乱：正确译文放在由题号决定的位置。
      const correctPosition = qi % OPTIONS_PER_QUESTION;
      const options: string[] = [];
      let di = 0;
      for (let slot = 0; slot < OPTIONS_PER_QUESTION; slot += 1) {
        if (slot === correctPosition) {
          options.push(stem.translation);
        } else {
          options.push(distractors[di]!.translation);
          di += 1;
        }
      }
      return {
        stemId: stem.id,
        word: stem.word,
        options,
        correctAnswer: stem.translation,
      };
    });

    return { ok: true, questions, totalDifficultyGap: result.cost };
  }

  /** 校验并取出题干词条。 */
  private resolveStems(stemIds: readonly string[]): WordEntry[] {
    if (stemIds.length !== QUESTIONS_PER_EXAM) {
      throw new Error(`expected ${QUESTIONS_PER_EXAM} stem ids, got ${stemIds.length}`);
    }
    const seen = new Set<string>();
    return stemIds.map((id) => {
      if (seen.has(id)) throw new Error(`duplicate stem id: ${id}`);
      seen.add(id);
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`unknown stem id: ${id}`);
      return entry;
    });
  }
}

function validateEntry(entry: WordEntry): void {
  if (!entry.id) throw new Error('entry id must be non-empty');
  if (!Number.isInteger(entry.difficulty) || entry.difficulty < 1 || entry.difficulty > 5) {
    throw new Error(`entry ${entry.id}: difficulty must be an integer in [1, 5]`);
  }
}
