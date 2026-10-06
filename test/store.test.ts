import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UploadStore, CHUNK_SIZE, UploadError } from '../src/index';
import { listFiles, makeBytes, sha256Hex, splitChunks, tmpDir } from './helper';

function makeFile(parts: number, lastSize: number, seed: number) {
  const data = makeBytes(CHUNK_SIZE * (parts - 1) + lastSize, seed);
  return { data, chunks: splitChunks(data), sha256: sha256Hex(data) };
}

test('start session: progress, idempotent restart, immutable declaration', () => {
  const dir = tmpDir('start');
  const store = new UploadStore({ dir });
  const file = makeFile(2, 100, 1);

  const progress = store.startSession({ sessionId: 's1', totalSize: file.data.length, sha256: file.sha256 });
  assert.equal(progress.sessionId, 's1');
  assert.equal(progress.chunkCount, 2);
  assert.equal(progress.completed, false);
  assert.deepEqual(progress.confirmedChunks, []);

  // Re-start with identical declaration keeps progress instead of resetting.
  store.submitChunk('s1', 0, file.chunks[0]);
  const restarted = store.startSession({ sessionId: 's1', totalSize: file.data.length, sha256: file.sha256 });
  assert.equal(restarted.confirmedChunks.length, 1);

  assert.throws(
    () => store.startSession({ sessionId: 's1', totalSize: file.data.length + 1, sha256: file.sha256 }),
    (err: unknown) => err instanceof UploadError && err.code === 'DECLARATION_CONFLICT',
  );
  assert.throws(
    () => store.startSession({ sessionId: 's1', totalSize: file.data.length, sha256: sha256Hex(Buffer.alloc(1)) }),
    (err: unknown) => err instanceof UploadError && err.code === 'DECLARATION_CONFLICT',
  );
  assert.throws(
    () => store.startSession({ sessionId: 'bad', totalSize: -1, sha256: file.sha256 }),
    (err: unknown) => err instanceof UploadError && err.code === 'INVALID_DECLARATION',
  );
  store.close();
});

test('submit chunk: out of order, size and index validation, progress query', () => {
  const dir = tmpDir('submit');
  const store = new UploadStore({ dir });
  const file = makeFile(3, 7, 2);
  store.startSession({ sessionId: 's', totalSize: file.data.length, sha256: file.sha256 });

  // Out-of-order submission.
  store.submitChunk('s', 2, file.chunks[2]);
  store.submitChunk('s', 0, file.chunks[0]);
  const progress = store.getProgress('s');
  assert.deepEqual(progress.confirmedChunks.map((c) => c.index), [0, 2]);
  assert.equal(progress.completed, false);

  // Wrong sizes are rejected.
  assert.throws(
    () => store.submitChunk('s', 1, Buffer.alloc(CHUNK_SIZE - 1)),
    (err: unknown) => err instanceof UploadError && err.code === 'INVALID_CHUNK_SIZE',
  );
  assert.throws(
    () => store.submitChunk('s', 2, Buffer.alloc(8)),
    (err: unknown) => err instanceof UploadError && err.code === 'INVALID_CHUNK_SIZE',
  );
  // Out-of-range index and unknown session are rejected.
  assert.throws(
    () => store.submitChunk('s', 3, Buffer.alloc(CHUNK_SIZE)),
    (err: unknown) => err instanceof UploadError && err.code === 'INVALID_CHUNK_INDEX',
  );
  assert.throws(
    () => store.submitChunk('nope', 0, Buffer.alloc(1)),
    (err: unknown) => err instanceof UploadError && err.code === 'SESSION_NOT_FOUND',
  );
  assert.throws(
    () => store.getProgress('nope'),
    (err: unknown) => err instanceof UploadError && err.code === 'SESSION_NOT_FOUND',
  );
  store.close();
});

test('resubmit: identical bytes are a no-op, conflicting bytes are rejected', () => {
  const dir = tmpDir('resubmit');
  const store = new UploadStore({ dir });
  const file = makeFile(2, 50, 3);
  store.startSession({ sessionId: 's', totalSize: file.data.length, sha256: file.sha256 });

  const first = store.submitChunk('s', 0, file.chunks[0]);
  const again = store.submitChunk('s', 0, file.chunks[0]);
  assert.deepEqual(again, first);
  // Still exactly one persisted chunk file.
  assert.equal(listFiles(path.join(dir, 'chunks')).length, 1);

  const different = makeBytes(CHUNK_SIZE, 999);
  assert.throws(
    () => store.submitChunk('s', 0, different),
    (err: unknown) => err instanceof UploadError && err.code === 'CHUNK_CONFLICT',
  );
  // Original data is preserved.
  store.submitChunk('s', 1, file.chunks[1]);
  const result = store.complete('s');
  assert.deepEqual(fs.readFileSync(result.fileRef), file.data);
  store.close();
});

test('complete: verifies content, publishes immutable file, stable across restarts', () => {
  const dir = tmpDir('complete');
  const file = makeFile(3, 1, 4);

  const store = new UploadStore({ dir });
  store.startSession({ sessionId: 's', totalSize: file.data.length, sha256: file.sha256 });
  assert.throws(
    () => store.complete('s'),
    (err: unknown) => err instanceof UploadError && err.code === 'SESSION_INCOMPLETE',
  );
  for (const [index, chunk] of file.chunks.entries()) store.submitChunk('s', index, chunk);
  const result = store.complete('s');
  assert.equal(result.sha256, file.sha256);
  assert.equal(result.size, file.data.length);
  assert.deepEqual(fs.readFileSync(result.fileRef), file.data);

  // The published file is read-only.
  const mode = fs.statSync(result.fileRef).mode & 0o777;
  assert.equal(mode, 0o444);
  assert.throws(() => fs.writeFileSync(result.fileRef, 'x'));

  // Repeating complete returns the same reference, also after reopening.
  assert.deepEqual(store.complete('s'), result);
  store.close();

  const reopened = new UploadStore({ dir });
  assert.deepEqual(reopened.complete('s'), result);
  const progress = reopened.getProgress('s');
  assert.equal(progress.completed, true);
  assert.equal(progress.fileRef, result.fileRef);
  reopened.close();
});

test('conflict rules still hold after completion cleaned the chunk copies', () => {
  const dir = tmpDir('post-complete');
  const store = new UploadStore({ dir });
  const file = makeFile(2, 10, 5);
  store.startSession({ sessionId: 's', totalSize: file.data.length, sha256: file.sha256 });
  store.submitChunk('s', 0, file.chunks[0]);
  store.submitChunk('s', 1, file.chunks[1]);
  const result = store.complete('s');

  // Chunk copies of the finished session are gone.
  assert.equal(listFiles(path.join(dir, 'chunks')).length, 0);

  // Same bytes still succeed; different bytes are still rejected.
  store.submitChunk('s', 0, file.chunks[0]);
  assert.throws(
    () => store.submitChunk('s', 0, makeBytes(CHUNK_SIZE, 1234)),
    (err: unknown) => err instanceof UploadError && err.code === 'CHUNK_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(result.fileRef), file.data);
  store.close();
});

test('two sessions with identical content share one stored file', () => {
  const dir = tmpDir('dedup');
  const store = new UploadStore({ dir });
  const file = makeFile(2, 33, 6);

  for (const sessionId of ['a', 'b']) {
    store.startSession({ sessionId, totalSize: file.data.length, sha256: file.sha256 });
    for (const [index, chunk] of file.chunks.entries()) store.submitChunk(sessionId, index, chunk);
  }
  const first = store.complete('a');
  const second = store.complete('b');
  assert.equal(first.fileRef, second.fileRef);
  assert.equal(listFiles(path.join(dir, 'files')).length, 1);
  assert.deepEqual(fs.readFileSync(second.fileRef), file.data);
  store.close();
});

test('a session cannot complete on mismatched bytes even when the declared file exists', () => {
  const dir = tmpDir('integrity');
  const store = new UploadStore({ dir });
  const good = makeFile(2, 20, 7);

  store.startSession({ sessionId: 'good', totalSize: good.data.length, sha256: good.sha256 });
  for (const [index, chunk] of good.chunks.entries()) store.submitChunk('good', index, chunk);
  const goodResult = store.complete('good');

  // Same declaration (total size + sha256), but the actual bytes differ.
  const bad = makeFile(2, 20, 8);
  assert.equal(bad.data.length, good.data.length);
  assert.notEqual(bad.sha256, good.sha256);
  store.startSession({ sessionId: 'bad', totalSize: good.data.length, sha256: good.sha256 });
  for (const [index, chunk] of bad.chunks.entries()) store.submitChunk('bad', index, chunk);
  assert.throws(
    () => store.complete('bad'),
    (err: unknown) => err instanceof UploadError && err.code === 'INTEGRITY_MISMATCH',
  );

  // The failed completion published nothing and the good file is intact.
  assert.equal(store.getProgress('bad').completed, false);
  assert.equal(listFiles(path.join(dir, 'files')).length, 1);
  assert.deepEqual(fs.readFileSync(goodResult.fileRef), good.data);
  store.close();
});
