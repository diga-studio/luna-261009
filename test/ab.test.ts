import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentStore } from '../src/index.js';
import type { ExperimentEvent, VariantStats } from '../src/index.js';

function tempDbPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ab-judge-'));
  return { dir, file: join(dir, 'ab.sqlite') };
}

function statsOf(result: { variants: VariantStats[] }, variant: string): VariantStats {
  const stats = result.variants.find((s) => s.variant === variant);
  assert.ok(stats, `missing stats for variant ${variant}`);
  return stats;
}

function exposure(eventId: string, visitorId: string, variant: string): ExperimentEvent {
  return { eventId, visitorId, variant, type: 'exposure' };
}

function conversion(eventId: string, visitorId: string, variant: string): ExperimentEvent {
  return { eventId, visitorId, variant, type: 'conversion' };
}

test('conversion-first, duplicate reports and crossing 199 -> 200', () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new ExperimentStore(file);
    store.createExperiment('exp1', ['A', 'B']);

    // Batch 1: conversions arrive before any exposure, plus duplicates and a
    // conversion from a visitor who never exposes.
    const batch1: ExperimentEvent[] = [];
    for (let i = 1; i <= 120; i += 1) batch1.push(conversion(`cvA${i}`, `vA${i}`, 'A'));
    for (let i = 1; i <= 100; i += 1) batch1.push(conversion(`cvB${i}`, `vB${i}`, 'B'));
    batch1.push(conversion('cvA1', 'vA1', 'A')); // same event id again
    batch1.push(conversion('cvA1-again', 'vA1', 'A')); // same behavior, new event id
    batch1.push(conversion('cvB2-again', 'vB2', 'B'));
    batch1.push(conversion('ghostCv', 'ghostA', 'A')); // never exposes
    store.ingestBatch('exp1', batch1);

    let result = store.getResult('exp1');
    assert.deepEqual(statsOf(result, 'A'), { variant: 'A', n: 0, c: 0 });
    assert.deepEqual(statsOf(result, 'B'), { variant: 'B', n: 0, c: 0 });
    assert.equal(result.lock, null);

    // Batch 2: 199 exposures per variant, with duplicate exposures mixed in.
    const batch2: ExperimentEvent[] = [];
    for (let i = 1; i <= 199; i += 1) batch2.push(exposure(`exA${i}`, `vA${i}`, 'A'));
    for (let i = 1; i <= 199; i += 1) batch2.push(exposure(`exB${i}`, `vB${i}`, 'B'));
    batch2.push(exposure('exA1', 'vA1', 'A')); // same event id again
    batch2.push(exposure('exA1-again', 'vA1', 'A')); // same behavior, new event id
    store.ingestBatch('exp1', batch2);

    result = store.getResult('exp1');
    assert.deepEqual(statsOf(result, 'A'), { variant: 'A', n: 199, c: 120 });
    assert.deepEqual(statsOf(result, 'B'), { variant: 'B', n: 199, c: 100 });
    assert.equal(result.lock, null, 'must not lock below 200 exposures per variant');

    // Batch 3: A reaches 200 but B is still at 199 -> no lock yet.
    store.ingestBatch('exp1', [exposure('exA200', 'vA200', 'A')]);
    result = store.getResult('exp1');
    assert.deepEqual(statsOf(result, 'A'), { variant: 'A', n: 200, c: 120 });
    assert.equal(result.lock, null);

    // Batch 4: B reaches 200 -> first event satisfying the lock condition.
    store.ingestBatch('exp1', [exposure('exB200', 'vB200', 'B')]);
    result = store.getResult('exp1');
    assert.equal(result.lock?.winner, 'A');
    assert.equal(result.lock?.triggerEventId, 'exB200');
    assert.deepEqual(result.lock?.stats, [
      { variant: 'A', n: 200, c: 120 },
      { variant: 'B', n: 200, c: 100 },
    ]);

    // Batch 5: post-lock events keep updating live stats but never the lock.
    store.ingestBatch('exp1', [
      conversion('cvA200', 'vA200', 'A'),
      exposure('exB200', 'vB200', 'B'), // duplicate of the locking event
      conversion('ghostCv-late', 'ghostA', 'A'), // ghost still has no exposure
    ]);
    result = store.getResult('exp1');
    assert.deepEqual(statsOf(result, 'A'), { variant: 'A', n: 200, c: 121 });
    assert.deepEqual(statsOf(result, 'B'), { variant: 'B', n: 200, c: 100 });
    assert.equal(result.lock?.winner, 'A');
    assert.equal(result.lock?.triggerEventId, 'exB200');
    assert.deepEqual(result.lock?.stats, [
      { variant: 'A', n: 200, c: 120 },
      { variant: 'B', n: 200, c: 100 },
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock survives when the advantage disappears later in the same batch', () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new ExperimentStore(file);
    store.createExperiment('exp2', ['A', 'B']);

    // 199 exposed visitors per variant: A 120/199, B 100/199.
    const batch1: ExperimentEvent[] = [];
    for (let i = 1; i <= 199; i += 1) batch1.push(exposure(`exA${i}`, `vA${i}`, 'A'));
    for (let i = 1; i <= 120; i += 1) batch1.push(conversion(`cvA${i}`, `vA${i}`, 'A'));
    for (let i = 1; i <= 199; i += 1) batch1.push(exposure(`exB${i}`, `vB${i}`, 'B'));
    for (let i = 1; i <= 100; i += 1) batch1.push(conversion(`cvB${i}`, `vB${i}`, 'B'));
    store.ingestBatch('exp2', batch1);
    assert.equal(store.getResult('exp2').lock, null);

    // One batch: both variants reach 200 (A wins at that point), then B's
    // remaining 100 exposed visitors convert and erase A's advantage.
    const batch2: ExperimentEvent[] = [
      exposure('exA200', 'vA200', 'A'),
      exposure('exB200', 'vB200', 'B'),
    ];
    for (let i = 101; i <= 200; i += 1) batch2.push(conversion(`cvB${i}`, `vB${i}`, 'B'));
    store.ingestBatch('exp2', batch2);

    const result = store.getResult('exp2');
    assert.deepEqual(statsOf(result, 'A'), { variant: 'A', n: 200, c: 120 });
    assert.deepEqual(statsOf(result, 'B'), { variant: 'B', n: 200, c: 200 });
    assert.equal(result.lock?.winner, 'A', 'locked winner must not change');
    assert.equal(result.lock?.triggerEventId, 'exB200');
    assert.deepEqual(result.lock?.stats, [
      { variant: 'A', n: 200, c: 120 },
      { variant: 'B', n: 200, c: 100 },
    ]);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('results persist across store instances on the same file', () => {
  const { dir, file } = tempDbPath();
  try {
    const first = new ExperimentStore(file);
    first.createExperiment('exp3', ['A', 'B', 'C']);
    first.ingestBatch('exp3', [exposure('ex1', 'v1', 'A'), conversion('cv1', 'v1', 'A')]);
    first.close();

    const second = new ExperimentStore(file);
    const result = second.getResult('exp3');
    assert.deepEqual(statsOf(result, 'A'), { variant: 'A', n: 1, c: 1 });
    assert.deepEqual(statsOf(result, 'B'), { variant: 'B', n: 0, c: 0 });
    assert.deepEqual(statsOf(result, 'C'), { variant: 'C', n: 0, c: 0 });
    assert.equal(result.lock, null);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('input validation', () => {
  const { dir, file } = tempDbPath();
  try {
    const store = new ExperimentStore(file);
    assert.throws(() => store.createExperiment('bad1', ['A']), /2 to 5/);
    assert.throws(() => store.createExperiment('bad2', ['A', 'B', 'C', 'D', 'E', 'F']), /2 to 5/);
    assert.throws(() => store.createExperiment('bad3', ['A', 'A']), /unique/);

    store.createExperiment('exp4', ['A', 'B']);
    assert.throws(() => store.createExperiment('exp4', ['A', 'B']), /already exists/);
    assert.throws(
      () => store.ingestBatch('exp4', [exposure('ex1', 'v1', 'Z')]),
      /unknown variant/,
    );
    assert.throws(() => store.getResult('missing'), /not found/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
