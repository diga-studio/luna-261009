import { MinCostFlow, type EdgeHandle } from "./minCostFlow.js";
import type { PaperResult, QuizQuestion, WordEntry } from "./types.js";

export const QUESTIONS_PER_PAPER = 20;
export const OPTIONS_PER_QUESTION = 4;
export const DISTRACTORS_PER_QUESTION = OPTIONS_PER_QUESTION - 1;
export const MAX_DIFFICULTY_GAP = 1;
export const MAX_TRANSLATION_USES = 2;

interface Assignment {
  questionIndex: number;
  entry: WordEntry;
}

/**
 * 在整张试卷范围内协调分配干扰项，生成总难度差最小的试卷。
 *
 * 建模为最小费用流：
 *   源点 -> 题目节点（容量 3，需满流）
 *   题目 -> （题目 × 译文）节点（容量 1，保证同题内译文互不相同）
 *   （题目 × 译文）-> 词条节点（容量 1，费用为难度差绝对值）
 *   词条 -> 译文节点（容量 1，保证同一词条整卷至多作一次干扰项）
 *   译文 -> 汇点（容量 2，同一译文整卷至多作两次干扰项）
 * 满流 60 即存在合法试卷，最小费用即最小总难度差。
 */
export function assemblePaper(bank: readonly WordEntry[], stems: readonly WordEntry[]): PaperResult {
  const stemIds = new Set(stems.map((stem) => stem.id));
  const candidates = bank.filter((entry) => !stemIds.has(entry.id));

  // 节点编号布局：0=源点，之后依次为题、(题×译文)、词条、译文、汇点。
  const source = 0;
  const questionNode = (index: number): number => 1 + index;

  const qtNode = new Map<string, number>();
  let nextNode = 1 + stems.length;
  const questionTranslations: string[][] = stems.map(() => []);
  for (let index = 0; index < stems.length; index += 1) {
    const seen = new Set<string>();
    for (const entry of candidates) {
      if (entry.tag !== stems[index]!.tag) continue;
      if (Math.abs(entry.difficulty - stems[index]!.difficulty) > MAX_DIFFICULTY_GAP) continue;
      if (entry.translation === stems[index]!.translation) continue;
      if (seen.has(entry.translation)) continue;
      seen.add(entry.translation);
      questionTranslations[index]!.push(entry.translation);
      qtNode.set(`${index}\u0000${entry.translation}`, nextNode);
      nextNode += 1;
    }
  }

  const entryNode = new Map<string, number>();
  for (const entry of candidates) {
    entryNode.set(entry.id, nextNode);
    nextNode += 1;
  }

  const translationNode = new Map<string, number>();
  for (const entry of candidates) {
    if (!translationNode.has(entry.translation)) {
      translationNode.set(entry.translation, nextNode);
      nextNode += 1;
    }
  }
  const sink = nextNode;
  nextNode += 1;

  const flow = new MinCostFlow(nextNode);
  for (let index = 0; index < stems.length; index += 1) {
    flow.addEdge(source, questionNode(index), DISTRACTORS_PER_QUESTION, 0);
    for (const translation of questionTranslations[index]!) {
      flow.addEdge(questionNode(index), qtNode.get(`${index}\u0000${translation}`)!, 1, 0);
    }
  }

  const assignmentEdges: Array<{ handle: EdgeHandle; questionIndex: number; entry: WordEntry }> = [];
  for (let index = 0; index < stems.length; index += 1) {
    const stem = stems[index]!;
    for (const entry of candidates) {
      if (entry.tag !== stem.tag) continue;
      const gap = Math.abs(entry.difficulty - stem.difficulty);
      if (gap > MAX_DIFFICULTY_GAP) continue;
      if (entry.translation === stem.translation) continue;
      const node = qtNode.get(`${index}\u0000${entry.translation}`)!;
      const handle = flow.addEdge(node, entryNode.get(entry.id)!, 1, gap);
      assignmentEdges.push({ handle, questionIndex: index, entry });
    }
  }

  for (const entry of candidates) {
    flow.addEdge(entryNode.get(entry.id)!, translationNode.get(entry.translation)!, 1, 0);
  }
  for (const node of translationNode.values()) {
    flow.addEdge(node, sink, MAX_TRANSLATION_USES, 0);
  }

  const targetFlow = stems.length * DISTRACTORS_PER_QUESTION;
  const { flow: achieved, cost } = flow.solve(source, sink, targetFlow);
  if (achieved < targetFlow) {
    return { ok: false, reason: "整卷范围内不存在满足全部约束的干扰项分配" };
  }

  const assignments: Assignment[] = [];
  for (const { handle, questionIndex, entry } of assignmentEdges) {
    if (flow.flowOn(handle) === 1) {
      assignments.push({ questionIndex, entry });
    }
  }

  const questions: QuizQuestion[] = stems.map((stem, index) => {
    const distractors = assignments
      .filter((assignment) => assignment.questionIndex === index)
      .map((assignment) => assignment.entry);
    if (distractors.length !== DISTRACTORS_PER_QUESTION) {
      throw new Error(`内部错误：第 ${index + 1} 题分配到 ${distractors.length} 个干扰项`);
    }
    const correctIndex = Math.floor(Math.random() * OPTIONS_PER_QUESTION);
    const options: string[] = distractors.map((entry) => entry.translation);
    options.splice(correctIndex, 0, stem.translation);
    return {
      stem,
      options: options as QuizQuestion["options"],
      correctIndex,
      distractors: distractors as QuizQuestion["distractors"],
    };
  });

  return { ok: true, questions, totalDifficultyGap: cost };
}
