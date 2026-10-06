"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ScoringEngine } = require("../dist/index.js");

const CATEGORIES = Array.from({ length: 10 }, (_, i) => `cat${i}`);
const EQUAL_WEIGHTS = Array(10).fill(1000);
const NEW_WEIGHTS = [4000, 2000, 500, 500, 500, 500, 500, 500, 500, 500];

/** Independent full recomputation, written straight from the spec. */
function independentCalc(categories, weights, scoresEntries, previous) {
  const composites = new Map();
  for (const [id, scores] of scoresEntries) {
    composites.set(
      id,
      scores.reduce((acc, s, i) => acc + s * weights[i], 0) / 10000,
    );
  }
  const values = [...composites.values()];
  const teamAverage =
    values.length === 0
      ? null
      : values.reduce((a, b) => a + b, 0) / values.length;
  const members = new Map();
  for (const [id, composite] of composites) {
    const below = values.filter((v) => v < composite).length;
    const equal = values.filter((v) => v === composite).length;
    const percentile = (100 * (below + equal / 2)) / values.length;
    const prev = previous[id];
    const eligible = prev !== undefined && prev < 3.0 && composite < 3.0;
    let targets = [];
    if (eligible) {
      const scores = scoresEntries.find(([mid]) => mid === id)[1];
      targets = scores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => a.s - b.s || a.i - b.i)
        .slice(0, 2)
        .map(({ i }) => categories[i]);
    }
    members.set(id, {
      memberId: id,
      composite,
      percentile,
      coachingEligible: eligible,
      coachingTargets: targets,
    });
  }
  return { teamAverage, members };
}

function assertSnapshotMatches(engine, expected) {
  const snapshot = engine.getSnapshot();
  if (expected.teamAverage === null) {
    assert.equal(engine.getTeamAverage(), null);
    assert.equal(snapshot.teamAverage, null);
  } else {
    assert.ok(
      Math.abs(engine.getTeamAverage() - expected.teamAverage) < 1e-12,
      `team average ${engine.getTeamAverage()} != ${expected.teamAverage}`,
    );
  }
  assert.equal(snapshot.members.size, expected.members.size);
  for (const [id, exp] of expected.members) {
    const got = engine.getMemberResult(id);
    assert.ok(got, `missing member ${id}`);
    assert.equal(got.composite, exp.composite, `${id} composite`);
    assert.equal(got.percentile, exp.percentile, `${id} percentile`);
    assert.equal(got.coachingEligible, exp.coachingEligible, `${id} eligible`);
    assert.deepEqual(
      got.coachingTargets,
      exp.coachingTargets,
      `${id} targets`,
    );
  }
}

function makeScores(fill, overrides = {}) {
  return Array.from({ length: 10 }, (_, i) => overrides[i] ?? fill);
}

test("score revision and weight replacement both match independent recomputation", async () => {
  const previous = { alice: 2.5, bob: 4.1, carol: 2.9 };
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
    previousComposites: previous,
  });
  assert.equal(engine.getTeamAverage(), null);

  const batch = [
    { memberId: "alice", scores: makeScores(2, { 3: 1, 7: 1 }) },
    { memberId: "bob", scores: makeScores(4) },
    { memberId: "carol", scores: makeScores(3) },
  ];
  engine.submitScores(batch);
  assertSnapshotMatches(
    engine,
    independentCalc(
      CATEGORIES,
      EQUAL_WEIGHTS,
      batch.map((b) => [b.memberId, b.scores]),
      previous,
    ),
  );

  // Revise one member's full scores; all other members stay intact.
  const revised = { memberId: "bob", scores: makeScores(1, { 0: 5 }) };
  engine.submitScores([revised]);
  const afterRevision = new Map([
    ["alice", batch[0].scores],
    ["bob", revised.scores],
    ["carol", batch[2].scores],
  ]);
  assertSnapshotMatches(
    engine,
    independentCalc(CATEGORIES, EQUAL_WEIGHTS, [...afterRevision], previous),
  );

  // Replace weights: until the promise resolves, old weights serve queries.
  const pending = engine.replaceWeights(NEW_WEIGHTS);
  assert.deepEqual([...engine.getWeights()], EQUAL_WEIGHTS);
  assertSnapshotMatches(
    engine,
    independentCalc(CATEGORIES, EQUAL_WEIGHTS, [...afterRevision], previous),
  );
  await pending;
  assert.deepEqual([...engine.getWeights()], NEW_WEIGHTS);
  assertSnapshotMatches(
    engine,
    independentCalc(CATEGORIES, NEW_WEIGHTS, [...afterRevision], previous),
  );
});

test("batch is all-or-nothing: invalid or duplicate entry rejects the whole batch", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
  });
  engine.submitScores([{ memberId: "alice", scores: makeScores(3) }]);

  assert.throws(() =>
    engine.submitScores([
      { memberId: "bob", scores: makeScores(2) },
      { memberId: "carol", scores: makeScores(6) }, // out of range
    ]),
  );
  assert.equal(engine.getMemberResult("bob"), null);
  assert.equal(engine.getMemberResult("carol"), null);

  assert.throws(() =>
    engine.submitScores([
      { memberId: "bob", scores: makeScores(2) },
      { memberId: "bob", scores: makeScores(4) }, // duplicate in one batch
    ]),
  );
  assert.equal(engine.getMemberResult("bob"), null);

  assert.throws(() =>
    engine.submitScores([{ memberId: "bob", scores: makeScores(2).slice(0, 9) }]),
  );
  assert.equal(engine.getMemberResult("bob"), null);

  // The pre-existing member is untouched by all failed batches.
  assert.equal(engine.getMemberResult("alice").composite, 3);
});

test("weight replacement validates and never publishes a bad weight set", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
  });
  assert.throws(() => engine.replaceWeights(Array(10).fill(999)));
  assert.throws(() => engine.replaceWeights(Array(9).fill(1000)));
  assert.throws(() => engine.replaceWeights([0, ...Array(9).fill(1000)]));
  assert.throws(() => engine.replaceWeights([1.5, ...Array(9).fill(1000)]));
  assert.deepEqual([...engine.getWeights()], EQUAL_WEIGHTS);
});

test("revision committed during weight recalculation is adopted by the new weights", async () => {
  const previous = { alice: 2.0 };
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
    previousComposites: previous,
  });
  engine.submitScores([
    { memberId: "alice", scores: makeScores(2) },
    { memberId: "bob", scores: makeScores(5) },
  ]);

  // Start recalculation, then commit a revision before it completes.
  const pending = engine.replaceWeights(NEW_WEIGHTS);
  const revision = { memberId: "alice", scores: makeScores(1, { 9: 5 }) };
  engine.submitScores([revision]);
  await pending;

  const expected = independentCalc(
    CATEGORIES,
    NEW_WEIGHTS,
    [
      ["alice", revision.scores],
      ["bob", makeScores(5)],
    ],
    previous,
  );
  assertSnapshotMatches(engine, expected);
});

test("heavy ties: equal composites share one percentile; alone or all-tied gives 50", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
  });

  // Single scored member -> percentile 50.
  engine.submitScores([{ memberId: "solo", scores: makeScores(4) }]);
  assert.equal(engine.getMemberResult("solo").percentile, 50);

  // Three members tied at the same composite, plus one below and one above.
  const tied = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
  });
  tied.submitScores([
    { memberId: "low", scores: makeScores(1) },
    { memberId: "mid1", scores: makeScores(3) },
    { memberId: "mid2", scores: makeScores(3, { 0: 5, 1: 1 }) }, // also 3.0
    { memberId: "mid3", scores: makeScores(3) },
    { memberId: "high", scores: makeScores(5) },
  ]);
  assert.equal(tied.getMemberResult("low").percentile, 10);
  for (const id of ["mid1", "mid2", "mid3"]) {
    assert.equal(tied.getMemberResult(id).composite, 3);
    assert.equal(tied.getMemberResult(id).percentile, 50);
  }
  assert.equal(tied.getMemberResult("high").percentile, 90);

  // All members tied -> everyone at 50.
  const allTied = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
  });
  allTied.submitScores([
    { memberId: "a", scores: makeScores(2) },
    { memberId: "b", scores: makeScores(2) },
    { memberId: "c", scores: makeScores(2) },
  ]);
  for (const id of ["a", "b", "c"]) {
    assert.equal(allTied.getMemberResult(id).percentile, 50);
  }
});

test("composite exactly 3.0 is not coaching-eligible", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
    previousComposites: { exact: 2.99, below: 2.99 },
  });
  engine.submitScores([
    { memberId: "exact", scores: makeScores(3) }, // composite 3.0
    { memberId: "below", scores: makeScores(3, { 0: 2 }) }, // composite 2.9
  ]);
  assert.equal(engine.getMemberResult("exact").composite, 3);
  assert.equal(engine.getMemberResult("exact").coachingEligible, false);
  assert.equal(engine.getMemberResult("below").coachingEligible, true);
});

test("missing previous period never counts as consecutive low scores", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
    previousComposites: { withPrev: 2.5 },
  });
  engine.submitScores([
    { memberId: "withPrev", scores: makeScores(2) },
    { memberId: "noPrev", scores: makeScores(1) },
  ]);
  assert.equal(engine.getMemberResult("withPrev").coachingEligible, true);
  assert.equal(engine.getMemberResult("noPrev").coachingEligible, false);
  assert.deepEqual(engine.getMemberResult("noPrev").coachingTargets, []);
});

test("coaching targets are the two lowest raw categories, ties by fixed order", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
    previousComposites: { p1: 1.0, p2: 2.0, p3: 1.5 },
  });
  engine.submitScores([
    // lowest raw scores at index 5 and 2 -> cat5, cat2? no: ties by category order
    { memberId: "p1", scores: makeScores(2, { 5: 1, 2: 1, 8: 3 }) },
    // all equal -> first two categories in fixed order
    { memberId: "p2", scores: makeScores(2) },
    // unique lowest at 9, second lowest tie at 0 and 3 -> cat9, cat0
    { memberId: "p3", scores: makeScores(3, { 9: 1, 0: 2, 3: 2 }) },
  ]);
  assert.deepEqual(engine.getMemberResult("p1").coachingTargets, ["cat2", "cat5"]);
  assert.deepEqual(engine.getMemberResult("p2").coachingTargets, ["cat0", "cat1"]);
  assert.deepEqual(engine.getMemberResult("p3").coachingTargets, ["cat9", "cat0"]);
});

test("unscored members are excluded from average and ranking", () => {
  const engine = new ScoringEngine({
    categories: CATEGORIES,
    weights: EQUAL_WEIGHTS,
    previousComposites: { ghost: 1.0 },
  });
  engine.submitScores([
    { memberId: "a", scores: makeScores(2) },
    { memberId: "b", scores: makeScores(4) },
  ]);
  assert.equal(engine.getMemberResult("ghost"), null);
  assert.equal(engine.getTeamAverage(), 3);
  assert.equal(engine.getMemberResult("a").percentile, 25);
  assert.equal(engine.getMemberResult("b").percentile, 75);
});
