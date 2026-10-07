const { test } = require("node:test");
const assert = require("node:assert/strict");
const { diagnose } = require("../dist/index.js");

const T = (name, columns, indexes) => ({ name, columns, indexes });

// 需求用例 1：索引 (a,b,c)，条件 a=1 AND (b=2 OR b>2) AND c=3，保证前缀为 2
test("guaranteed prefix is min across OR branches", () => {
  const report = diagnose(
    "SELECT * FROM t WHERE a = 1 AND (b = 2 OR b > 2) AND c = 3",
    [T("t", ["a", "b", "c"], [["a", "b", "c"]])],
  );
  assert.equal(report.instances.length, 1);
  assert.deepEqual(report.instances[0].indexes, [
    { columns: ["a", "b", "c"], guaranteedPrefix: 2 },
  ]);
  assert.equal(report.instances[0].hasFullScanBranch, false);
});

// 需求用例 2：两个 OR 分支分别由不同索引覆盖，不得标记全扫分支
test("branches covered by different indexes: no full-scan branch", () => {
  const report = diagnose("SELECT * FROM t WHERE a = 1 OR b = 2", [
    T("t", ["a", "b"], [["a"], ["b"]]),
  ]);
  const inst = report.instances[0];
  assert.deepEqual(inst.indexes, [
    { columns: ["a"], guaranteedPrefix: 0 },
    { columns: ["b"], guaranteedPrefix: 0 },
  ]);
  assert.equal(inst.hasFullScanBranch, false);
});

test("full-scan branch flagged when some branch has zero prefix on all indexes", () => {
  const report = diagnose("SELECT * FROM t WHERE a = 1 OR c = 2", [
    T("t", ["a", "b", "c"], [["a"], ["b"]]),
  ]);
  assert.equal(report.instances[0].hasFullScanBranch, true);
});

test("no condition at all means full scan", () => {
  const report = diagnose("SELECT a FROM t", [T("t", ["a"], [["a"]])]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 0);
  assert.equal(report.instances[0].hasFullScanBranch, true);
});

test("leftmost prefix: equality chain then at most one range column", () => {
  const report = diagnose("SELECT * FROM t WHERE a = 1 AND b = 2 AND c > 3 AND d = 4", [
    T("t", ["a", "b", "c", "d"], [["a", "b", "c", "d"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 3);
});

test("prefix stops at unconstrained index column", () => {
  const report = diagnose("SELECT * FROM t WHERE a = 1 AND c = 3", [
    T("t", ["a", "b", "c"], [["a", "b", "c"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 1);
});

test("IN and IS NULL count as equality", () => {
  const report = diagnose("SELECT * FROM t WHERE a IN (1, 2, 3) AND b IS NULL AND c > 0", [
    T("t", ["a", "b", "c"], [["a", "b", "c"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 3);
});

test("equality wins when same column has both eq and range", () => {
  const report = diagnose("SELECT * FROM t WHERE a > 1 AND a = 5 AND b > 2", [
    T("t", ["a", "b"], [["a", "b"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("column-to-column comparison in same block gives no constraint", () => {
  const report = diagnose("SELECT * FROM t WHERE a = b", [
    T("t", ["a", "b"], [["a"], ["b"]]),
  ]);
  assert.equal(report.instances[0].hasFullScanBranch, true);
});

test("operands may be swapped", () => {
  const report = diagnose("SELECT * FROM t WHERE 1 = a AND 5 > b", [
    T("t", ["a", "b"], [["a", "b"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("BETWEEN counts as range", () => {
  const report = diagnose("SELECT * FROM t WHERE a = 1 AND b BETWEEN 2 AND 5", [
    T("t", ["a", "b"], [["a", "b"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("same table read twice yields two separate instances", () => {
  const report = diagnose(
    "SELECT * FROM t WHERE a = 1; SELECT * FROM t WHERE b = 2;",
    [T("t", ["a", "b"], [["a"], ["b"]])],
  );
  assert.equal(report.instances.length, 2);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 1);
  assert.equal(report.instances[0].indexes[1].guaranteedPrefix, 0);
  assert.equal(report.instances[1].indexes[0].guaranteedPrefix, 0);
  assert.equal(report.instances[1].indexes[1].guaranteedPrefix, 1);
});

test("CTE is transparent: outer condition maps through rename to base column", () => {
  const report = diagnose(
    "WITH c AS (SELECT a AS x, b FROM t WHERE b > 10) SELECT * FROM c WHERE x = 1",
    [T("t", ["a", "b"], [["a", "b"]])],
  );
  assert.equal(report.instances.length, 1);
  assert.equal(report.instances[0].table, "t");
  // a 等值 + b 范围 => 前缀 2
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("CTE referenced twice is diagnosed as two instances", () => {
  const report = diagnose(
    "WITH c AS (SELECT a FROM t WHERE a = 1) SELECT * FROM c; SELECT * FROM c;",
    [T("t", ["a"], [["a"]])],
  );
  // 注意：两条语句各自引用一次 c
  assert.equal(report.instances.length, 2);
});

test("CTE may reference previously defined CTE", () => {
  const report = diagnose(
    "WITH c1 AS (SELECT a, b FROM t WHERE a = 1), c2 AS (SELECT b FROM c1 WHERE b = 2) SELECT * FROM c2",
    [T("t", ["a", "b"], [["a", "b"]])],
  );
  assert.equal(report.instances.length, 1);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("FROM subquery is transparent and layers combine", () => {
  const report = diagnose(
    "SELECT * FROM (SELECT a AS x, b FROM t WHERE b = 2) s WHERE s.x = 1",
    [T("t", ["a", "b"], [["a", "b"]])],
  );
  assert.equal(report.instances.length, 1);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("EXISTS inner instance diagnosed independently; predicates do not leak", () => {
  const report = diagnose(
    "SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.a = 1 AND t2.b = t1.c)",
    [
      T("t1", ["c"], [["c"]]),
      T("t2", ["a", "b"], [["a", "b"]]),
    ],
  );
  assert.equal(report.instances.length, 2);
  const outer = report.instances.find((i) => i.table === "t1");
  const inner = report.instances.find((i) => i.table === "t2");
  // 父查询无约束 => 全扫
  assert.equal(outer.hasFullScanBranch, true);
  // 内层 a=1 等值 + b=外层列 等值 => 前缀 2
  assert.equal(inner.indexes[0].guaranteedPrefix, 2);
  assert.equal(inner.hasFullScanBranch, false);
});

test("table alias hides original name; unquoted names are lowercased", () => {
  const report = diagnose("SELECT * FROM MyTab AS m WHERE m.A = 1", [
    T("mytab", ["a"], [["a"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 1);
});

test("quoted identifiers are case-sensitive", () => {
  const report = diagnose('SELECT * FROM "MyTab" WHERE "A" = 1', [
    T("MyTab", ["A"], [["A"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 1);
});

test("keywords inside strings do not affect structure", () => {
  const report = diagnose("SELECT * FROM t WHERE a = 'select from where' AND b = 2", [
    T("t", ["a", "b"], [["a", "b"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 2);
});

test("inner alias shadows outer scope binding", () => {
  const report = diagnose(
    "SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 AS t1 WHERE t1.a = 1)",
    [T("t1", ["a"], [["a"]]), T("t2", ["a"], [["a"]])],
  );
  const inner = report.instances.find((i) => i.table === "t2");
  assert.equal(inner.indexes[0].guaranteedPrefix, 1);
});

test("OR inside AND across layers via view", () => {
  const report = diagnose(
    "SELECT * FROM (SELECT a, b, c FROM t WHERE a = 1) s WHERE s.b = 2 OR s.c = 3",
    [T("t", ["a", "b", "c"], [["a", "b"], ["a", "c"]])],
  );
  const inst = report.instances[0];
  // 分支1: a,b => idx1 前缀2, idx2 前缀1；分支2: a,c => idx1 前缀1, idx2 前缀2
  assert.deepEqual(inst.indexes, [
    { columns: ["a", "b"], guaranteedPrefix: 1 },
    { columns: ["a", "c"], guaranteedPrefix: 1 },
  ]);
  assert.equal(inst.hasFullScanBranch, false);
});

test("EXISTS can reference statement-level CTE", () => {
  const report = diagnose(
    "WITH c AS (SELECT a FROM t WHERE a = 1) SELECT * FROM t2 WHERE EXISTS (SELECT 1 FROM c)",
    [T("t", ["a"], [["a"]]), T("t2", ["x"], [["x"]])],
  );
  const inner = report.instances.find((i) => i.table === "t");
  assert.equal(inner.indexes[0].guaranteedPrefix, 1);
});

test("NOT IN / IS NOT NULL / NOT BETWEEN give no constraint", () => {
  const report = diagnose(
    "SELECT * FROM t WHERE a NOT IN (1,2) AND b IS NOT NULL AND c NOT BETWEEN 1 AND 2",
    [T("t", ["a", "b", "c"], [["a"], ["b"], ["c"]])],
  );
  assert.equal(report.instances[0].hasFullScanBranch, true);
});

test("correlated EXISTS: outer column acts as value on inner column", () => {
  const report = diagnose(
    "SELECT * FROM t1 WHERE t1.k = 9 AND EXISTS (SELECT 1 FROM t2 WHERE t2.f = t1.k)",
    [T("t1", ["k"], [["k"]]), T("t2", ["f"], [["f"]])],
  );
  const outer = report.instances.find((i) => i.table === "t1");
  const inner = report.instances.find((i) => i.table === "t2");
  assert.equal(outer.indexes[0].guaranteedPrefix, 1);
  assert.equal(inner.indexes[0].guaranteedPrefix, 1);
});

test("inequality operators give no constraint", () => {
  const report = diagnose("SELECT * FROM t WHERE a <> 1 AND b != 2", [
    T("t", ["a", "b"], [["a"], ["b"]]),
  ]);
  assert.equal(report.instances[0].hasFullScanBranch, true);
});

test("batch of multiple statements separated by semicolons", () => {
  const report = diagnose(
    "SELECT * FROM t1 WHERE a = 1; SELECT * FROM t2 WHERE b = 2",
    [T("t1", ["a"], [["a"]]), T("t2", ["b"], [["b"]])],
  );
  assert.equal(report.instances.length, 2);
});

test("IN list containing a same-block column gives no constraint", () => {
  const report = diagnose("SELECT * FROM t WHERE a IN (1, b)", [
    T("t", ["a", "b"], [["a"]]),
  ]);
  assert.equal(report.instances[0].indexes[0].guaranteedPrefix, 0);
});
