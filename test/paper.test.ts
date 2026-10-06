import { test } from "node:test";
import assert from "node:assert/strict";
import { QuizPaperLibrary, type PaperSuccess, type WordEntry } from "../src/index.js";

function entry(id: string, tag: string, difficulty: number, translation?: string): WordEntry {
  return { id, word: `word-${id}`, translation: translation ?? `tr-${id}`, tag, difficulty };
}

/** 校验试卷满足全部硬约束。 */
function assertPaperValid(paper: PaperSuccess, stems: WordEntry[], bank: WordEntry[]): void {
  assert.equal(paper.questions.length, 20);
  const stemIds = new Set(stems.map((stem) => stem.id));
  const usedDistractorIds = new Map<string, number>();
  const usedDistractorTranslations = new Map<string, number>();
  let gapSum = 0;

  for (const [index, question] of paper.questions.entries()) {
    assert.equal(question.stem.id, stems[index]!.id, "题干顺序与指定一致");
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options).size, 4, "4 个选项互不相同");
    assert.equal(question.options[question.correctIndex], question.stem.translation);
    assert.equal(question.distractors.length, 3);

    for (const distractor of question.distractors) {
      assert.ok(bank.some((item) => item.id === distractor.id), "干扰项来自词库");
      assert.ok(!stemIds.has(distractor.id), "题干词条不能作为干扰项");
      assert.equal(distractor.tag, question.stem.tag, "行业标签相同");
      const gap = Math.abs(distractor.difficulty - question.stem.difficulty);
      assert.ok(gap <= 1, "难度差不超过 1");
      assert.ok(question.options.includes(distractor.translation));
      gapSum += gap;
      usedDistractorIds.set(distractor.id, (usedDistractorIds.get(distractor.id) ?? 0) + 1);
      usedDistractorTranslations.set(
        distractor.translation,
        (usedDistractorTranslations.get(distractor.translation) ?? 0) + 1,
      );
    }
  }

  for (const [id, count] of usedDistractorIds) {
    assert.ok(count <= 1, `词条 ${id} 整卷至多作一次干扰项`);
  }
  for (const [translation, count] of usedDistractorTranslations) {
    assert.ok(count <= 2, `译文 ${translation} 整卷至多作两次干扰项`);
  }
  assert.equal(paper.totalDifficultyGap, gapSum, "上报的总难度差与实际一致");
}

test("重新分配后整卷可行，且总难度差达到可独立核对的最优值", () => {
  // 竞争结构（标签 G）：
  //   Q1（难度 1）候选：ga(1) gb(1) gc(2) gf(1)
  //   Q2（难度 3）候选：gc(2) gd(3) ge(3)，仅有这三个，必须全部使用
  // 若 Q1 占掉同为 gap 0 的 gc，Q2 将凑不齐 3 个干扰项。
  // 唯一可行分配：Q1 用 ga/gb/gf（gap 0），Q2 用 gc/gd/ge（gap 1+0+0）。
  // 因此整卷最优总难度差 = 1，可独立核对。
  const stems: WordEntry[] = [
    entry("q1", "G", 1, "stem-1"),
    entry("q2", "G", 3, "stem-2"),
  ];
  const bank: WordEntry[] = [
    ...stems,
    entry("ga", "G", 1),
    entry("gb", "G", 1),
    entry("gc", "G", 2),
    entry("gd", "G", 3),
    entry("ge", "G", 3),
    entry("gf", "G", 1),
  ];
  // 其余 18 题各占独立标签，各有 3 个 gap 0 的专属候选，不干扰竞争结构。
  for (let index = 3; index <= 20; index += 1) {
    const tag = `F${index}`;
    const stem = entry(`q${index}`, tag, 3, `stem-${index}`);
    stems.push(stem);
    bank.push(stem);
    for (let k = 0; k < 3; k += 1) {
      bank.push(entry(`f${index}-${k}`, tag, 3));
    }
  }

  const library = new QuizPaperLibrary();
  library.loadWordBank(bank);
  const result = library.generatePaper(stems.map((stem) => stem.id));

  assert.ok(result.ok, "重新分配后整卷必须可行");
  assertPaperValid(result, stems, bank);
  assert.equal(result.totalDifficultyGap, 1, "总难度差等于可独立核对的最优值");
  const q1 = result.questions[0]!;
  const q2 = result.questions[1]!;
  assert.deepEqual(
    q1.distractors.map((item) => item.id).sort(),
    ["ga", "gb", "gf"],
    "Q1 不得占用 Q2 必需的 gc",
  );
  assert.deepEqual(
    q2.distractors.map((item) => item.id).sort(),
    ["gc", "gd", "ge"],
  );
});

test("每题单独都有足够候选，整卷因共享译文配额无法完成", () => {
  // 60 个干扰词条仅覆盖 29 个不同译文（t0 有 4 条，t1..t28 各 2 条）。
  // 每个译文整卷至多作 2 次干扰项，最多支撑 29*2=58 个干扰位，不足 60。
  // 但每题单独看都有 60 个合格候选（同一标签、难度相同）。
  const stems: WordEntry[] = [];
  const bank: WordEntry[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const stem = entry(`q${index}`, "S", 3, `stem-${index}`);
    stems.push(stem);
    bank.push(stem);
  }
  for (let t = 0; t <= 28; t += 1) {
    const copies = t === 0 ? 4 : 2;
    for (let k = 0; k < copies; k += 1) {
      bank.push(entry(`d${t}-${k}`, "S", 3, `shared-${t}`));
    }
  }

  const library = new QuizPaperLibrary();
  library.loadWordBank(bank);
  const result = library.generatePaper(stems.map((stem) => stem.id));

  assert.equal(result.ok, false, "整卷必须准确返回无法组卷");
});

test("常规词库可组卷并满足全部约束", () => {
  const stems: WordEntry[] = [];
  const bank: WordEntry[] = [];
  for (let index = 1; index <= 20; index += 1) {
    const tag = `T${(index % 4) + 1}`;
    const difficulty = (index % 5) + 1;
    const stem = entry(`q${index}`, tag, difficulty, `stem-${index}`);
    stems.push(stem);
    bank.push(stem);
  }
  // 每个标签补充 30 个词条，难度 1..5 循环，译文部分共享以触发配额约束。
  for (let t = 1; t <= 4; t += 1) {
    for (let k = 0; k < 30; k += 1) {
      bank.push(entry(`x${t}-${k}`, `T${t}`, (k % 5) + 1, `pool-${t}-${k % 20}`));
    }
  }

  const library = new QuizPaperLibrary();
  library.loadWordBank(bank);
  const result = library.generatePaper(stems.map((stem) => stem.id));

  assert.ok(result.ok);
  assertPaperValid(result, stems, bank);
});

test("非法输入抛错", () => {
  const library = new QuizPaperLibrary();
  library.loadWordBank([entry("a", "T", 1)]);
  assert.throws(() => library.generatePaper(["a"]), /20/);
  assert.throws(
    () => library.generatePaper(Array.from({ length: 20 }, () => "a")),
    /重复/,
  );
  assert.throws(
    () => library.generatePaper(Array.from({ length: 20 }, (_, i) => `missing-${i}`)),
    /不在词库中/,
  );
  assert.throws(
    () => library.loadWordBank([entry("a", "T", 1), entry("a", "T", 2)]),
    /重复/,
  );
  assert.throws(() => library.loadWordBank([entry("b", "T", 6)]), /难度/);
});
