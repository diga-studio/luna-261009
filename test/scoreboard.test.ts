import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createScoreBoard,
  ValidationError,
  type MemberView,
  type ScoreSet,
  type TeamView,
  type WeightSet,
} from "../src/index.ts";

const CATEGORIES = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
const UNIFORM: WeightSet = Array(10).fill(1000);

/** 独立全量计算：测试专用参考实现，与被测代码不共享任何逻辑 */
function referenceViews(
  weights: readonly number[],
  previous: ReadonlyMap<string, number>,
  scores: ReadonlyMap<string, readonly number[]>,
): { team: TeamView; members: Map<string, MemberView> } {
  const scaled = new Map<string, number>();
  for (const [m, s] of scores) {
    scaled.set(m, s.reduce((acc, v, i) => acc + v * weights[i], 0));
  }
  const n = scaled.size;
  let total = 0;
  for (const v of scaled.values()) total += v;
  const team: TeamView = {
    scoredCount: n,
    average: n === 0 ? null : total / (n * 10000),
  };
  const members = new Map<string, MemberView>();
  for (const [m, v] of scaled) {
    let below = 0;
    let equal = 0;
    for (const other of scaled.values()) {
      if (other < v) below++;
      else if (other === v) equal++;
    }
    const prev = previous.get(m);
    const eligible = prev !== undefined && prev < 3.0 && v < 30000;
    const targets: string[] = [];
    if (eligible) {
      const s = scores.get(m)!;
      const order = s
        .map((score, index) => ({ score, index }))
        .sort((a, b) => a.score - b.score || a.index - b.index);
      targets.push(CATEGORIES[order[0].index], CATEGORIES[order[1].index]);
    }
    members.set(m, {
      composite: v / 10000,
      percentile: (100 * (below + equal / 2)) / n,
      coachingEligible: eligible,
      coachingTargets: targets,
    });
  }
  return { team, members };
}

function assertBoardMatches(
  board: ReturnType<typeof createScoreBoard>,
  weights: readonly number[],
  previous: ReadonlyMap<string, number>,
  scores: ReadonlyMap<string, readonly number[]>,
  extraMembers: string[] = [],
): void {
  const ref = referenceViews(weights, previous, scores);
  assert.deepEqual(board.teamView(), ref.team);
  for (const m of [...scores.keys(), ...extraMembers]) {
    assert.deepEqual(board.memberView(m), ref.members.get(m) ?? null, `member ${m}`);
  }
}

const closeTo = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("基础：均分、综合分、百分位与独立全量计算一致", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  const scores = new Map<string, ScoreSet>([
    ["m1", [5, 4, 3, 2, 1, 5, 4, 3, 2, 1]],
    ["m2", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]],
    ["m3", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
  ]);
  board.submitScores(scores);
  assertBoardMatches(board, UNIFORM, new Map(), scores, ["ghost"]);
  closeTo(board.memberView("m1")!.composite, 3.0);
  closeTo(board.memberView("m2")!.composite, 3.0);
  closeTo(board.memberView("m1")!.percentile, 100 * (1 + 1) / 3); // 与 m2 同分
  closeTo(board.memberView("m3")!.percentile, 100 * 0.5 / 3);
  assert.equal(board.memberView("ghost"), null);
});

test("评分修订：修订后查询必须看到新评分，且与全量重算一致", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  const v1 = new Map<string, ScoreSet>([
    ["a", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ["b", [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ]);
  board.submitScores(v1);
  assertBoardMatches(board, UNIFORM, new Map(), v1);

  const v2 = new Map<string, ScoreSet>([
    ["a", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]], // 修订 a
    ["c", [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]], // 新增 c
  ]);
  board.submitScores(v2);
  const merged = new Map([...v1, ...v2]);
  assertBoardMatches(board, UNIFORM, new Map(), merged);
  closeTo(board.memberView("a")!.composite, 5.0);
});

test("同批评分必须全部同时生效：任一非法则整批拒绝", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  board.submitScores(new Map([["x", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]]]));
  const bad = new Map<string, ScoreSet>([
    ["y", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]],
    ["z", [0, 5, 5, 5, 5, 5, 5, 5, 5, 5]], // 非法：0 分
  ]);
  assert.throws(() => board.submitScores(bad), ValidationError);
  // y 不得部分生效，x 保持原值
  assert.equal(board.memberView("y"), null);
  assert.equal(board.memberView("z"), null);
  closeTo(board.memberView("x")!.composite, 3.0);
  assert.equal(board.teamView().scoredCount, 1);
});

test("权重替换：替换前后两版结果分别与独立全量计算一致", () => {
  const previous = new Map([
    ["p1", 2.5],
    ["p2", 3.4],
  ]);
  const w1: WeightSet = [2000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 500, 500];
  const w2: WeightSet = [500, 500, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
  const board = createScoreBoard({
    categories: CATEGORIES,
    weights: w1,
    previousComposites: previous,
  });
  const scores = new Map<string, ScoreSet>([
    ["p1", [5, 1, 2, 3, 4, 5, 1, 2, 3, 4]],
    ["p2", [1, 5, 4, 3, 2, 1, 5, 4, 3, 2]],
    ["p3", [2, 2, 3, 3, 2, 2, 3, 3, 2, 2]],
  ]);
  board.submitScores(scores);
  // 旧权重版本
  assertBoardMatches(board, w1, previous, scores);
  const before = board.memberView("p1")!;
  // 替换权重：完成时一次性发布
  board.replaceWeights(w2);
  // 新权重版本：已提交的评分修订必须被新权重采用
  assertBoardMatches(board, w2, previous, scores);
  const after = board.memberView("p1")!;
  assert.notEqual(before.composite, after.composite);
  closeTo(after.composite, scores.get("p1")!.reduce((a, v, i) => a + v * w2[i], 0) / 10000);
  // 替换后再修订，查询必须同时看到新权重与新评分
  const revised = new Map<string, ScoreSet>([
    ...scores,
    ["p1", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
  ]);
  board.submitScores(new Map([["p1", revised.get("p1")!]]));
  assertBoardMatches(board, w2, previous, revised);
});

test("非法权重整批拒绝且旧权重继续生效", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  board.submitScores(new Map([["m", [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]]]));
  assert.throws(
    () => board.replaceWeights([2000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]),
    ValidationError,
  ); // 总和 11000
  assert.throws(
    () => board.replaceWeights([0, 2000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]),
    ValidationError,
  ); // 非正整数
  closeTo(board.memberView("m")!.composite, 4.0); // 旧权重仍生效
});

test("大量同分：同分成员百分位相同，全员同分为 50", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  const scores = new Map<string, ScoreSet>();
  for (let i = 0; i < 40; i++) scores.set(`low${i}`, Array(10).fill(2));
  for (let i = 0; i < 60; i++) scores.set(`mid${i}`, Array(10).fill(3));
  board.submitScores(scores);
  assertBoardMatches(board, UNIFORM, new Map(), scores);
  // 40 个低分 + 60 个同分：100*(40 + 30)/100 = 70
  closeTo(board.memberView("mid0")!.percentile, 70);
  closeTo(board.memberView("mid59")!.percentile, 70);
  closeTo(board.memberView("low0")!.percentile, 100 * 20 / 100); // 20

  const solo = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  solo.submitScores(new Map([["only", [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]]]));
  closeTo(solo.memberView("only")!.percentile, 50); // 只有一人为 50

  const allTied = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  allTied.submitScores(
    new Map([
      ["t1", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]],
      ["t2", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]],
      ["t3", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]],
    ]),
  );
  closeTo(allTied.memberView("t1")!.percentile, 50); // 全员同分为 50
  closeTo(allTied.memberView("t3")!.percentile, 50);
});

test("综合分恰好 3.0 不具备辅导资格（严格低于）", () => {
  const previous = new Map([["edge", 2.0]]);
  const board = createScoreBoard({
    categories: CATEGORIES,
    weights: UNIFORM,
    previousComposites: previous,
  });
  // 各项之和 30，综合分恰好 3.0
  board.submitScores(new Map([["edge", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]]]));
  const view = board.memberView("edge")!;
  closeTo(view.composite, 3.0);
  assert.equal(view.coachingEligible, false);
  assert.deepEqual(view.coachingTargets, []);

  // 上一周期恰好 3.0 同样不具备资格
  const prev3 = createScoreBoard({
    categories: CATEGORIES,
    weights: UNIFORM,
    previousComposites: new Map([["edge2", 3.0]]),
  });
  prev3.submitScores(new Map([["edge2", [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]]]));
  assert.equal(prev3.memberView("edge2")!.coachingEligible, false);
});

test("上一周期缺失不算连续低分", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  board.submitScores(new Map([["noprev", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]]));
  const view = board.memberView("noprev")!;
  assert.ok(view.composite < 3.0);
  assert.equal(view.coachingEligible, false);
  assert.deepEqual(view.coachingTargets, []);
});

test("辅导目标：当前周期原始评分最低的两个类别，并列按固定类别顺序", () => {
  const previous = new Map([["coach", 2.0]]);
  const board = createScoreBoard({
    categories: CATEGORIES,
    weights: UNIFORM,
    previousComposites: previous,
  });
  // 最低分 1 出现在 c4、c2、c9（并列），按类别顺序取 c2、c4
  board.submitScores(
    new Map([["coach", [3, 1, 3, 1, 3, 3, 3, 3, 1, 3]]]),
  );
  const view = board.memberView("coach")!;
  assert.equal(view.coachingEligible, true);
  assert.deepEqual(view.coachingTargets, ["c2", "c4"]);
});

test("未评分成员不参与均分和排名", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  assert.deepEqual(board.teamView(), { scoredCount: 0, average: null });
  board.submitScores(
    new Map([
      ["s1", [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]],
      ["s2", [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
    ]),
  );
  closeTo(board.teamView().average!, 3.0);
  assert.equal(board.teamView().scoredCount, 2);
  // 未评分成员不影响 s1 的百分位
  closeTo(board.memberView("s1")!.percentile, 75);
  assert.equal(board.memberView("unscored"), null);
});

test("同一批次的评分对均分与排名同时可见", () => {
  const board = createScoreBoard({ categories: CATEGORIES, weights: UNIFORM });
  board.submitScores(new Map([["old", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]]]));
  board.submitScores(
    new Map([
      ["n1", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]],
      ["n2", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ]),
  );
  // 批次完成后，均分与两个新成员的排名同时反映新状态
  closeTo(board.teamView().average!, 3.0);
  closeTo(board.memberView("n1")!.percentile, 100 * 2.5 / 3);
  closeTo(board.memberView("n2")!.percentile, 100 * 0.5 / 3);
});

test("初始化校验：类别与权重不合法时拒绝", () => {
  assert.throws(
    () => createScoreBoard({ categories: ["only"], weights: UNIFORM }),
    ValidationError,
  );
  assert.throws(
    () =>
      createScoreBoard({
        categories: CATEGORIES,
        weights: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 999],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      createScoreBoard({
        categories: CATEGORIES,
        weights: UNIFORM,
        previousComposites: new Map([["bad", Number.NaN]]),
      }),
    ValidationError,
  );
});
