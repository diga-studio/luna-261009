const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../dist/index');

function table(name, columns, indexes) {
  return { name, columns, indexes: indexes.map((cols, i) => ({ name: `idx_${i}`, columns: cols })) };
}

function prefixOf(report, indexName) {
  const found = report.indexes.find((idx) => idx.index === indexName);
  assert.ok(found, `index ${indexName} reported`);
  return found.guaranteedPrefix;
}

test('required: a=1 AND (b=2 OR b>2) AND c=3 guarantees prefix 2 on (a,b,c)', () => {
  const tables = [table('t', ['a', 'b', 'c'], [['a', 'b', 'c']])];
  const [report] = diagnose('SELECT * FROM t WHERE a = 1 AND (b = 2 OR b > 2) AND c = 3', tables);
  assert.equal(prefixOf(report, 'idx_0'), 2);
  assert.equal(report.hasFullScanBranch, false);
});

test('required: OR branches covered by different indexes => no full-scan branch', () => {
  const tables = [table('t', ['a', 'b'], [['a'], ['b']])];
  const [report] = diagnose('SELECT * FROM t WHERE a = 1 OR b = 2', tables);
  // Each single index guarantees zero across the two branches...
  assert.equal(prefixOf(report, 'idx_0'), 0);
  assert.equal(prefixOf(report, 'idx_1'), 0);
  // ...but every branch has some usable index, so no full-scan branch.
  assert.equal(report.hasFullScanBranch, false);
});

test('branch with no usable index on any index => full-scan branch', () => {
  const tables = [table('t', ['a', 'b', 'c'], [['a'], ['b']])];
  // Branch "c = 2" constrains no indexed column: zero prefix on every index.
  const [report] = diagnose('SELECT * FROM t WHERE a = 1 OR c = 2', tables);
  assert.equal(prefixOf(report, 'idx_0'), 0);
  assert.equal(prefixOf(report, 'idx_1'), 0);
  assert.equal(report.hasFullScanBranch, true);
  // A range branch is still usable: no full scan here.
  const [ranged] = diagnose('SELECT * FROM t WHERE b > 2', tables);
  assert.equal(prefixOf(ranged, 'idx_1'), 1);
  assert.equal(ranged.hasFullScanBranch, false);
});

test('unconditional read is a full-scan branch', () => {
  const tables = [table('t', ['a'], [['a']])];
  const [report] = diagnose('SELECT a FROM t', tables);
  assert.equal(prefixOf(report, 'idx_0'), 0);
  assert.equal(report.hasFullScanBranch, true);
});

test('unquoted names fold to lowercase, quoted names are case-sensitive', () => {
  const tables = [table('users', ['id', 'Name'], [['id']])];
  const [report] = diagnose('SELECT ID FROM Users WHERE id = 5', tables);
  assert.equal(report.table, 'users');
  assert.equal(prefixOf(report, 'idx_0'), 1);
  // Quoted identifier must match exactly.
  const [r2] = diagnose('SELECT "Name" FROM users WHERE "Name" = \'x\' AND id = 1', tables);
  assert.equal(prefixOf(r2, 'idx_0'), 1);
  assert.throws(() => diagnose('SELECT "name" FROM users', tables), /Unknown column/);
});

test('table alias hides the original table name', () => {
  const tables = [table('t', ['a'], [['a']])];
  const [report] = diagnose('SELECT u.a FROM t u WHERE u.a = 1', tables);
  assert.equal(report.alias, 'u');
  assert.equal(prefixOf(report, 'idx_0'), 1);
  assert.throws(() => diagnose('SELECT t.a FROM t u', tables), /Unknown table reference/);
});

test('keywords inside string literals do not affect parsing', () => {
  const tables = [table('t', ['a', 'note'], [['a']])];
  const [report] = diagnose(
    "SELECT note FROM t WHERE a = 1 AND note = 'select * from x where y in (1) or exists'",
    tables,
  );
  assert.equal(prefixOf(report, 'idx_0'), 1);
});

test('CTE is transparent: outer predicate maps through a renamed column', () => {
  const tables = [table('t', ['a', 'b'], [['a', 'b']])];
  const [report] = diagnose(
    'WITH c AS (SELECT a AS x, b FROM t WHERE b > 10) SELECT x FROM c WHERE x = 7',
    tables,
  );
  assert.equal(report.table, 't');
  // Outer x = 7 reaches base column a; inner b > 10 adds a range on b.
  assert.equal(prefixOf(report, 'idx_0'), 2);
});

test('each reference to the same CTE is diagnosed separately', () => {
  const tables = [table('t', ['a'], [['a']])];
  const reports = diagnose(
    'WITH c AS (SELECT a FROM t) SELECT x.a FROM c x WHERE x.a = 1 AND EXISTS (SELECT a FROM c)',
    tables,
  );
  assert.equal(reports.length, 2);
  assert.equal(prefixOf(reports[0], 'idx_0'), 1);
  assert.equal(prefixOf(reports[1], 'idx_0'), 0);
  assert.equal(reports[1].hasFullScanBranch, true);
});

test('CTE may reference previously defined CTEs only', () => {
  const tables = [table('t', ['a'], [['a']])];
  const [report] = diagnose(
    'WITH c1 AS (SELECT a FROM t WHERE a = 1), c2 AS (SELECT a FROM c1) SELECT a FROM c2',
    tables,
  );
  assert.equal(prefixOf(report, 'idx_0'), 1);
});

test('FROM subquery is transparent and layers combine', () => {
  const tables = [table('t', ['a', 'b', 'c'], [['a', 'b', 'c']])];
  const [report] = diagnose(
    'SELECT s.b FROM (SELECT a AS b, c FROM t WHERE c = 3) s WHERE s.b = 2',
    tables,
  );
  // s.b maps to base a (equality), inner c = 3 is equality on third column;
  // middle column b is unconstrained, so the prefix stops at 1.
  assert.equal(prefixOf(report, 'idx_0'), 1);
});

test('same table read twice is reported as two independent instances', () => {
  const tables = [table('t', ['a'], [['a']])];
  const reports = diagnose(
    'SELECT a FROM t WHERE a = 1; SELECT a FROM t',
    tables,
  );
  assert.equal(reports.length, 2);
  assert.equal(prefixOf(reports[0], 'idx_0'), 1);
  assert.equal(prefixOf(reports[1], 'idx_0'), 0);
});

test('EXISTS gives the parent no constraint; inner instance diagnosed independently', () => {
  const tables = [
    table('t1', ['a', 'b'], [['a']]),
    table('t2', ['c', 'd'], [['c']]),
  ];
  const reports = diagnose(
    'SELECT a FROM t1 WHERE EXISTS (SELECT d FROM t2 WHERE t2.c = t1.a AND d = 4)',
    tables,
  );
  assert.equal(reports.length, 2);
  const outer = reports.find((r) => r.table === 't1');
  const inner = reports.find((r) => r.table === 't2');
  // Parent gets nothing from EXISTS.
  assert.equal(prefixOf(outer, 'idx_0'), 0);
  assert.equal(outer.hasFullScanBranch, true);
  // Inner: c = outer column counts as equality, d = 4 is not in the index.
  assert.equal(prefixOf(inner, 'idx_0'), 1);
  assert.equal(inner.hasFullScanBranch, false);
});

test('inner predicates do not leak into the parent query', () => {
  const tables = [
    table('t1', ['a'], [['a']]),
    table('t2', ['a'], [['a']]),
  ];
  const reports = diagnose(
    'SELECT a FROM t1 WHERE EXISTS (SELECT a FROM t2 WHERE a = 1)',
    tables,
  );
  const outer = reports.find((r) => r.table === 't1');
  assert.equal(prefixOf(outer, 'idx_0'), 0);
});

test('IN and IS NULL count as equality constraints', () => {
  const tables = [table('t', ['a', 'b', 'c'], [['a', 'b', 'c']])];
  const [report] = diagnose(
    'SELECT * FROM t WHERE a IN (1, 2, 3) AND b IS NULL AND c = 5',
    tables,
  );
  assert.equal(prefixOf(report, 'idx_0'), 3);
});

test('equality plus range on the same column counts as equality', () => {
  const tables = [table('t', ['a', 'b'], [['a', 'b']])];
  const [report] = diagnose('SELECT * FROM t WHERE a = 1 AND a > 0 AND b = 2', tables);
  assert.equal(prefixOf(report, 'idx_0'), 2);
});

test('range column ends the usable prefix; unconstrained gaps stop it', () => {
  const tables = [table('t', ['a', 'b', 'c'], [['a', 'b', 'c']])];
  const [range] = diagnose('SELECT * FROM t WHERE a = 1 AND b > 2 AND c = 3', tables);
  assert.equal(prefixOf(range, 'idx_0'), 2);
  const [gap] = diagnose('SELECT * FROM t WHERE a = 1 AND c = 3', tables);
  assert.equal(prefixOf(gap, 'idx_0'), 1);
  const [between] = diagnose('SELECT * FROM t WHERE a BETWEEN 1 AND 9', tables);
  assert.equal(prefixOf(between, 'idx_0'), 1);
});

test('comparison sides may be swapped', () => {
  const tables = [table('t', ['a'], [['a']])];
  const [report] = diagnose('SELECT * FROM t WHERE 5 = a', tables);
  assert.equal(prefixOf(report, 'idx_0'), 1);
  const [range] = diagnose('SELECT * FROM t WHERE 5 < a', tables);
  assert.equal(prefixOf(range, 'idx_0'), 1);
});

test('column-to-column comparison in one block gives no constraint', () => {
  const tables = [table('t', ['a', 'b'], [['a'], ['b']])];
  const [report] = diagnose('SELECT * FROM t WHERE a = b', tables);
  assert.equal(prefixOf(report, 'idx_0'), 0);
  assert.equal(report.hasFullScanBranch, true);
});

test('inner alias shadows outer scope; correlated references bind to the nearest scope', () => {
  const tables = [
    table('t1', ['a'], [['a']]),
    table('t2', ['a'], [['a']]),
  ];
  const reports = diagnose(
    'SELECT a FROM t1 WHERE EXISTS (SELECT a FROM t2 WHERE a = 7)',
    tables,
  );
  const inner = reports.find((r) => r.table === 't2');
  // Unqualified "a" binds to t2 (nearest), not to the outer t1.
  assert.equal(prefixOf(inner, 'idx_0'), 1);
});

test('boolean and string literals work on the non-column side', () => {
  const tables = [table('t', ['flag', 'name'], [['flag'], ['name']])];
  const [report] = diagnose(
    "SELECT * FROM t WHERE flag = true AND name = 'abc'",
    tables,
  );
  assert.equal(prefixOf(report, 'idx_0'), 1);
  assert.equal(prefixOf(report, 'idx_1'), 1);
});
