import test from 'node:test';
import assert from 'node:assert/strict';
import { ExamBuilder } from '../src/index';
import type { ExamSuccess, WordEntry } from '../src/index';

let seq = 0;
function entry(
  industry: string,
  difficulty: number,
  translation?: string,
): WordEntry {
  seq += 1;
  const id = `e${seq}`;
  return { id, word: `w_${id}`, translation: translation ?? `t_${id}`, industry, difficulty };
}

function makeStems(count: number, industry: string, difficulty: number): WordEntry[] {
  return Array.from({ length: count }, () => entry(industry, difficulty));
}

/** 场景一：局部最优会抢占后续题目的必需资源，整卷协调后可行。 */
function buildReassignmentScenario(): { stems: WordEntry[]; bank: WordEntry[] } {
  seq = 0;
  // Q1 难度 3；X 难度 3（对 Q1 差距 0，最“诱人”）；P1..P3 难度 2（对 Q1 差距 1）。
  const q1 = entry('T', 3);
  const x = entry('T', 3);
  const p1 = entry('T', 2);
  const p2 = entry('T', 2);
  const p3 = entry('T', 2);
  // Q2 难度 4；合格候选恰好只有 X（差距 1）、P4、P5（差距 0）。
  const q2 = entry('T', 4);
  const p4 = entry('T', 4);
  const p5 = entry('T', 4);
  // Q3..Q20 难度 1，各自私有候选难度 1（差距 0），与其余题干均不兼容。
  const rest = makeStems(18, 'T', 1);
  const restPool = Array.from({ length: 54 }, () => entry('T', 1));
  const stems = [q1, q2, ...rest];
  const bank = [...stems, x, p1, p2, p3, p4, p5, ...restPool];
  return { stems, bank };
}

test('整卷协调分配：重排后可行且总难度差等于独立核算的最优值', () => {
  const { stems, bank } = buildReassignmentScenario();
  const builder = new ExamBuilder();
  builder.loadEntries(bank);
  const result = builder.generateExam(stems.map((s) => s.id));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 最优分配唯一：Q2 只能拿 {X, P4, P5}（费用 1），Q1 只能拿 {P1, P2, P3}（费用 3），
  // 其余 18 题拿 54 个差距 0 的私有候选（费用 0），总计 4。
  assert.equal(result.totalDifficultyGap, 4);
  assertExamShape(result, stems);
});

/** 场景二：每题候选充足，但共享译文配额导致整卷不可行。 */
test('共享译文配额耗尽：准确返回无法组卷', () => {
  seq = 0;
  const stems = makeStems(20, 'T', 3);
  // 29 个译文 x 3 个词条：每题都有 87 个合格候选，
  // 但每个译文整卷最多用 2 次，最多提供 58 个干扰项 < 60。
  const pool: WordEntry[] = [];
  for (let t = 0; t < 29; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      pool.push(entry('T', 3, `shared_${t}`));
    }
  }
  const builder = new ExamBuilder();
  builder.loadEntries([...stems, ...pool]);
  const result = builder.generateExam(stems.map((s) => s.id));
  assert.equal(result.ok, false);
});

test('常规词库：全部硬规则在整卷范围内成立', () => {
  seq = 0;
  const stems: WordEntry[] = [];
  const pool: WordEntry[] = [];
  // 两个行业、难度 1..5 的题干各若干。
  for (let i = 0; i < 20; i += 1) {
    stems.push(entry(i % 2 === 0 ? 'A' : 'B', (i % 5) + 1));
  }
  // 充足的干扰候选：每个行业 x 难度 各 12 个词条。
  for (const industry of ['A', 'B']) {
    for (let d = 1; d <= 5; d += 1) {
      for (let k = 0; k < 12; k += 1) {
        pool.push(entry(industry, d));
      }
    }
  }
  const builder = new ExamBuilder();
  builder.loadEntries([...stems, ...pool]);
  const result = builder.generateExam(stems.map((s) => s.id));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assertExamShape(result, stems);

  // 整卷约束：词条最多用一次、译文最多两次、题干不作干扰项。
  const stemIds = new Set(stems.map((s) => s.id));
  const byTranslation = new Map(pool.map((p) => [p.translation, p]));
  const usedEntries = new Set<string>();
  const usedTranslations = new Map<string, number>();
  let gap = 0;
  for (const q of result.questions) {
    const stem = stems.find((s) => s.id === q.stemId)!;
    for (const option of q.options) {
      if (option === q.correctAnswer) continue;
      const source = byTranslation.get(option)!;
      assert.ok(source, '干扰项必须来自词库');
      assert.ok(!stemIds.has(source.id), '题干不能作为干扰项');
      assert.equal(source.industry, stem.industry, '行业标签必须一致');
      assert.ok(Math.abs(source.difficulty - stem.difficulty) <= 1, '难度差不超过 1');
      assert.ok(!usedEntries.has(source.id), '同一词条整卷最多用一次');
      usedEntries.add(source.id);
      usedTranslations.set(option, (usedTranslations.get(option) ?? 0) + 1);
      assert.ok(usedTranslations.get(option)! <= 2, '同一译文整卷最多出现 2 次');
      gap += Math.abs(source.difficulty - stem.difficulty);
    }
  }
  assert.equal(usedEntries.size, 60);
  assert.equal(gap, result.totalDifficultyGap);
});

test('非法输入：题干数量、重复与未知标识均抛错', () => {
  seq = 0;
  const stems = makeStems(20, 'T', 3);
  const builder = new ExamBuilder();
  builder.loadEntries(stems);
  assert.throws(() => builder.generateExam(stems.slice(0, 19).map((s) => s.id)));
  assert.throws(() =>
    builder.generateExam([...stems.slice(0, 19), stems[0]!].map((s) => s.id)),
  );
  assert.throws(() =>
    builder.generateExam([...stems.slice(0, 19).map((s) => s.id), 'missing']),
  );
});

test('词库校验：重复标识与非法难度抛错', () => {
  seq = 0;
  const builder = new ExamBuilder();
  const a = entry('T', 3);
  assert.throws(() => builder.loadEntries([a, { ...a }]));
  assert.throws(() => builder.loadEntries([entry('T', 0)]));
  assert.throws(() => builder.loadEntries([entry('T', 6)]));
});

/** 校验试卷的基本形状：20 题、每题 4 个互异选项且含正确译文。 */
function assertExamShape(result: ExamSuccess, stems: WordEntry[]): void {
  assert.equal(result.questions.length, 20);
  assert.deepEqual(
    result.questions.map((q) => q.stemId),
    stems.map((s) => s.id),
  );
  for (const q of result.questions) {
    const stem = stems.find((s) => s.id === q.stemId)!;
    assert.equal(q.word, stem.word);
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options).size, 4, '4 个译文必须互不相同');
    assert.ok(q.options.includes(q.correctAnswer));
    assert.equal(q.correctAnswer, stem.translation);
  }
}
