import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UploadStore, CHUNK_SIZE } from '../src/index';
import { dirSize, listFiles, makeBytes, sha256Hex, splitChunks, tmpDir } from './helper';

const CHILD = path.join(__dirname, 'child.js');

interface ChildAction {
  op: 'start' | 'submit' | 'complete' | 'progress';
  sessionId: string;
  totalSize?: number;
  sha256?: string;
  index?: number;
  dataPath?: string;
}

interface ChildLine {
  ok?: boolean;
  result?: unknown;
  error?: string;
  done?: boolean;
}

/** Run the child driver; it may be killed mid-program. Returns output lines. */
function runChild(program: {
  dir: string;
  crashAt?: string;
  killAfterAction?: number;
  actions: ChildAction[];
}): ChildLine[] {
  const programPath = path.join(program.dir, 'program.json');
  fs.writeFileSync(programPath, JSON.stringify(program));
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [CHILD, programPath], { encoding: 'utf8' });
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  fs.rmSync(programPath, { force: true });
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ChildLine);
}

function makeFile(parts: number, lastSize: number, seed: number) {
  const data = makeBytes(CHUNK_SIZE * (parts - 1) + lastSize, seed);
  return { data, chunks: splitChunks(data), sha256: sha256Hex(data) };
}

function writeChunks(dir: string, prefix: string, chunks: Buffer[]): string[] {
  return chunks.map((chunk, i) => {
    const p = path.join(dir, `${prefix}-${i}.bin`);
    fs.writeFileSync(p, chunk);
    return p;
  });
}

test('submit killed before returning: confirmed progress does not regress', () => {
  const dir = tmpDir('crash-submit');
  const file = makeFile(3, 9, 11);
  const chunkPaths = writeChunks(dir, "c", file.chunks);

  // Killed after the chunk became durable but before the call returned.
  const lines = runChild({
    dir,
    crashAt: 'submitChunk:afterDbInsert@2',
    actions: [
      { op: 'start', sessionId: 's', totalSize: file.data.length, sha256: file.sha256 },
      { op: 'submit', sessionId: 's', index: 0, dataPath: chunkPaths[0] },
      { op: 'submit', sessionId: 's', index: 1, dataPath: chunkPaths[1] },
    ],
  });
  assert.equal(lines.filter((l) => l.ok).length, 2); // start + first submit returned

  const store = new UploadStore({ dir });
  const progress = store.getProgress('s');
  assert.deepEqual(progress.confirmedChunks.map((c) => c.index), [0, 1]);
  // The client continues from confirmed progress without resubmitting.
  store.submitChunk('s', 2, file.chunks[2]);
  const result = store.complete('s');
  assert.deepEqual(fs.readFileSync(result.fileRef), file.data);
  store.close();
});

test('submit killed after returning: chunk stays confirmed across reopen', () => {
  const dir = tmpDir('crash-submit-after');
  const file = makeFile(2, 5, 12);
  const chunkPaths = writeChunks(dir, "c", file.chunks);

  runChild({
    dir,
    killAfterAction: 2,
    actions: [
      { op: 'start', sessionId: 's', totalSize: file.data.length, sha256: file.sha256 },
      { op: 'submit', sessionId: 's', index: 0, dataPath: chunkPaths[0] },
      { op: 'submit', sessionId: 's', index: 1, dataPath: chunkPaths[1] },
    ],
  });

  const store = new UploadStore({ dir });
  assert.equal(store.getProgress('s').confirmedChunks.length, 2);
  const result = store.complete('s');
  assert.deepEqual(fs.readFileSync(result.fileRef), file.data);
  store.close();
});

test('submit killed between file write and db commit leaves no visible half chunk', () => {
  const dir = tmpDir('crash-submit-orphan');
  const file = makeFile(2, 5, 13);
  const chunkPaths = writeChunks(dir, "c", file.chunks);

  runChild({
    dir,
    crashAt: 'submitChunk:afterFileWrite',
    actions: [
      { op: 'start', sessionId: 's', totalSize: file.data.length, sha256: file.sha256 },
      { op: 'submit', sessionId: 's', index: 0, dataPath: chunkPaths[0] },
    ],
  });

  const store = new UploadStore({ dir });
  // The interrupted call never returned: it is as if it never happened.
  assert.equal(store.getProgress('s').confirmedChunks.length, 0);
  assert.equal(listFiles(path.join(dir, 'chunks')).length, 0);
  // Retrying works and stores exactly one copy.
  store.submitChunk('s', 0, file.chunks[0]);
  assert.equal(listFiles(path.join(dir, 'chunks')).length, 1);
  store.submitChunk('s', 1, file.chunks[1]);
  const result = store.complete('s');
  assert.deepEqual(fs.readFileSync(result.fileRef), file.data);
  store.close();
});

for (const point of ['complete:afterAssemble', 'complete:afterPublish', 'complete:afterMarkCompleted', 'complete:beforeReturn']) {
  test(`complete killed at ${point}: retry finishes with a stable reference`, () => {
    const dir = tmpDir('crash-complete');
    const file = makeFile(2, 42, 14);
    const chunkPaths = writeChunks(dir, "c", file.chunks);

    runChild({
      dir,
      crashAt: point,
      actions: [
        { op: 'start', sessionId: 's', totalSize: file.data.length, sha256: file.sha256 },
        { op: 'submit', sessionId: 's', index: 0, dataPath: chunkPaths[0] },
        { op: 'submit', sessionId: 's', index: 1, dataPath: chunkPaths[1] },
        { op: 'complete', sessionId: 's' },
      ],
    });

    // Recovery may itself be interrupted; reopening twice must still work.
    const store = new UploadStore({ dir });
    store.close();
    const reopened = new UploadStore({ dir });
    const result = reopened.complete('s');
    assert.equal(result.sha256, file.sha256);
    assert.deepEqual(fs.readFileSync(result.fileRef), file.data);

    // Stable reference on every subsequent call, and no leftovers.
    assert.deepEqual(reopened.complete('s'), result);
    assert.equal(listFiles(path.join(dir, 'files')).length, 1);
    assert.equal(listFiles(path.join(dir, 'chunks')).length, 0);
    assert.equal(listFiles(path.join(dir, 'staging')).length, 0);
    assert.equal(listFiles(path.join(dir, 'tmp')).length, 0);
    reopened.close();
  });
}

test('complete killed after returning: reference is stable across reopen', () => {
  const dir = tmpDir('crash-complete-after');
  const file = makeFile(2, 3, 15);
  const chunkPaths = writeChunks(dir, "c", file.chunks);

  const lines = runChild({
    dir,
    killAfterAction: 3,
    actions: [
      { op: 'start', sessionId: 's', totalSize: file.data.length, sha256: file.sha256 },
      { op: 'submit', sessionId: 's', index: 0, dataPath: chunkPaths[0] },
      { op: 'submit', sessionId: 's', index: 1, dataPath: chunkPaths[1] },
      { op: 'complete', sessionId: 's' },
    ],
  });
  const completeLine = lines.find((l) => l.ok && (l.result as { fileRef?: string })?.fileRef);
  assert.ok(completeLine, 'complete returned before the kill');
  const fileRef = (completeLine!.result as { fileRef: string }).fileRef;

  const store = new UploadStore({ dir });
  assert.equal(store.complete('s').fileRef, fileRef);
  assert.deepEqual(fs.readFileSync(fileRef), file.data);
  store.close();
});

test('recovery keeps confirmed chunks of unfinished sessions and reclaims the rest', () => {
  const dir = tmpDir('crash-recovery-usage');
  const done = makeFile(2, 8, 16);
  const pending = makeFile(3, 100, 17);
  const donePaths = writeChunks(dir, "done", done.chunks);
  const pendingPaths = writeChunks(dir, 'pending', pending.chunks);

  // One session completes; another keeps 2 of 3 chunks; a third dies
  // mid-publish, leaving an unowned complete file behind.
  const other = makeFile(1, 500, 18);
  const otherPaths = writeChunks(dir, "other", other.chunks);
  runChild({
    dir,
    actions: [
      { op: 'start', sessionId: 'done', totalSize: done.data.length, sha256: done.sha256 },
      { op: 'submit', sessionId: 'done', index: 0, dataPath: donePaths[0] },
      { op: 'submit', sessionId: 'done', index: 1, dataPath: donePaths[1] },
      { op: 'complete', sessionId: 'done' },
      { op: 'start', sessionId: 'pending', totalSize: pending.data.length, sha256: pending.sha256 },
      { op: 'submit', sessionId: 'pending', index: 0, dataPath: pendingPaths[0] },
      { op: 'submit', sessionId: 'pending', index: 2, dataPath: pendingPaths[2] },
    ],
  });
  runChild({
    dir,
    crashAt: 'complete:afterPublish',
    actions: [
      { op: 'start', sessionId: 'other', totalSize: other.data.length, sha256: other.sha256 },
      { op: 'submit', sessionId: 'other', index: 0, dataPath: otherPaths[0] },
      { op: 'complete', sessionId: 'other' },
    ],
  });

  const store = new UploadStore({ dir });
  // Unfinished session keeps exactly its confirmed chunks.
  assert.deepEqual(store.getProgress('pending').confirmedChunks.map((c) => c.index), [0, 2]);
  // The interrupted 'other' session was never marked complete, so its
  // confirmed chunk is retained as well.
  const chunkFiles = listFiles(path.join(dir, 'chunks'));
  assert.equal(chunkFiles.length, 3);
  assert.equal(dirSize(path.join(dir, 'chunks')), CHUNK_SIZE + 100 + 500);
  // The unowned complete file from the interrupted session was reclaimed.
  assert.deepEqual(listFiles(path.join(dir, 'files')), [done.sha256]);
  assert.equal(dirSize(path.join(dir, 'files')), done.data.length);
  assert.equal(listFiles(path.join(dir, 'tmp')).length, 0);
  assert.equal(listFiles(path.join(dir, 'staging')).length, 0);

  // The interrupted session can still finish afterwards.
  const result = store.complete('other');
  assert.deepEqual(fs.readFileSync(result.fileRef), other.data);
  store.close();
});

test('two sessions, same content, one killed mid-publish: single shared file remains', () => {
  const dir = tmpDir('crash-dedup');
  const file = makeFile(2, 64, 19);
  const chunkPaths = writeChunks(dir, "c", file.chunks);

  runChild({
    dir,
    actions: [
      { op: 'start', sessionId: 'a', totalSize: file.data.length, sha256: file.sha256 },
      { op: 'submit', sessionId: 'a', index: 0, dataPath: chunkPaths[0] },
      { op: 'submit', sessionId: 'a', index: 1, dataPath: chunkPaths[1] },
      { op: 'complete', sessionId: 'a' },
    ],
  });
  runChild({
    dir,
    crashAt: 'complete:afterPublish',
    actions: [
      { op: 'start', sessionId: 'b', totalSize: file.data.length, sha256: file.sha256 },
      { op: 'submit', sessionId: 'b', index: 0, dataPath: chunkPaths[0] },
      { op: 'submit', sessionId: 'b', index: 1, dataPath: chunkPaths[1] },
      { op: 'complete', sessionId: 'b' },
    ],
  });

  const store = new UploadStore({ dir });
  const first = store.complete('a');
  const second = store.complete('b');
  assert.equal(first.fileRef, second.fileRef);
  assert.equal(listFiles(path.join(dir, 'files')).length, 1);
  assert.equal(dirSize(path.join(dir, 'files')), file.data.length);
  assert.deepEqual(fs.readFileSync(second.fileRef), file.data);
  store.close();
});
