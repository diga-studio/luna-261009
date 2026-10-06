import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { UploadStore, CHUNK_SIZE, UploadError } from '../src/index';
import { makeBytes, sha256Hex, tmpDir } from './helper';

test('zero-byte file completes with no chunks', () => {
  const dir = tmpDir('edge-empty');
  const store = new UploadStore({ dir });
  const sha256 = sha256Hex(Buffer.alloc(0));
  const progress = store.startSession({ sessionId: 'empty', totalSize: 0, sha256 });
  assert.equal(progress.chunkCount, 0);

  assert.throws(
    () => store.submitChunk('empty', 0, Buffer.alloc(0)),
    (err: unknown) => err instanceof UploadError && err.code === 'INVALID_CHUNK_INDEX',
  );

  const result = store.complete('empty');
  assert.equal(result.size, 0);
  assert.equal(fs.readFileSync(result.fileRef).length, 0);
  store.close();
});

test('file of exactly one full chunk', () => {
  const dir = tmpDir('edge-exact');
  const store = new UploadStore({ dir });
  const data = makeBytes(CHUNK_SIZE, 42);
  store.startSession({ sessionId: 'exact', totalSize: data.length, sha256: sha256Hex(data) });
  store.submitChunk('exact', 0, data);
  // A second chunk is not implied by the declared size.
  assert.throws(
    () => store.submitChunk('exact', 1, Buffer.alloc(1)),
    (err: unknown) => err instanceof UploadError && err.code === 'INVALID_CHUNK_INDEX',
  );
  const result = store.complete('exact');
  assert.deepEqual(fs.readFileSync(result.fileRef), data);
  store.close();
});

test('restarting a completed session keeps its result', () => {
  const dir = tmpDir('edge-restart');
  const store = new UploadStore({ dir });
  const data = makeBytes(100, 7);
  const sha256 = sha256Hex(data);
  store.startSession({ sessionId: 's', totalSize: data.length, sha256 });
  store.submitChunk('s', 0, data);
  const result = store.complete('s');

  const progress = store.startSession({ sessionId: 's', totalSize: data.length, sha256 });
  assert.equal(progress.completed, true);
  assert.equal(progress.fileRef, result.fileRef);
  store.close();
});
