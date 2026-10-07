import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotUploadService, UploadError } from '../src/service';
import { CHUNK_SIZE } from '../src/types';
import { chunkOf, declOf, makeBytes, sha256Hex } from './helpers/fixture';

const SCENARIO = path.join(__dirname, 'helpers', 'scenario.js');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crashlens-'));
}

interface RunOut {
  status: number | null;
  signal: NodeJS.Signals | null;
  lines: Record<string, unknown>[];
}

function runScenario(name: string, dir: string): RunOut {
  const r = spawnSync(process.execPath, [SCENARIO, name, dir], { encoding: 'utf8' });
  const lines = (r.stdout as string)
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { status: r.status, signal: r.signal, lines };
}

function attachmentFiles(dir: string, ticketId: string): string[] {
  const p = path.join(dir, 'attachments', encodeURIComponent(ticketId));
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

const FILE_A = makeBytes(1, 2 * CHUNK_SIZE + 100);
const FILE_B = makeBytes(2, CHUNK_SIZE + 50);
const FILE_C = makeBytes(3, 2 * CHUNK_SIZE);
const FILE_D = makeBytes(4, 300);

test('begin: identical retry reuses batch, changed declaration is rejected', () => {
  const dir = tmpDir();
  const svc = new ScreenshotUploadService(dir);
  const decl = [declOf(FILE_B)];
  const first = svc.begin('K', 'T', decl);
  assert.equal(first.reused, false);
  const retry = svc.begin('K', 'T', decl);
  assert.equal(retry.reused, true);
  assert.equal(retry.state, 'open');
  assert.throws(() => svc.begin('K', 'T', [declOf(FILE_C)]), (e: unknown) => {
    assert.equal((e as UploadError).code, 'DECLARATION_MISMATCH');
    return true;
  });
  assert.throws(() => svc.begin('K', 'OTHER', decl), (e: unknown) => {
    assert.equal((e as UploadError).code, 'DECLARATION_MISMATCH');
    return true;
  });
  // Original batch unchanged.
  const insp = svc.inspect('K');
  assert.equal(insp.ticketId, 'T');
  assert.equal(insp.state, 'open');
  svc.close();
});

test('begin: validates declaration shape', () => {
  const dir = tmpDir();
  const svc = new ScreenshotUploadService(dir);
  assert.throws(() => svc.begin('K', 'T', []), /1 to 5/);
  assert.throws(
    () => svc.begin('K', 'T', Array.from({ length: 6 }, () => declOf(FILE_D))),
    /1 to 5/,
  );
  assert.throws(
    () => svc.begin('K', 'T', [{ byteLength: -1, sha256: '0'.repeat(64) }]),
    /byteLength/,
  );
  assert.throws(() => svc.begin('K', 'T', [{ byteLength: 1, sha256: 'zz' }]), /sha256/);
  svc.close();
});

test('putChunk: validation, identical retry, conflict rejection, incomplete commit', () => {
  const dir = tmpDir();
  const svc = new ScreenshotUploadService(dir);
  svc.begin('K', 'T', [declOf(FILE_B)]); // 2 chunks
  assert.throws(() => svc.putChunk('K', 1, 0, chunkOf(FILE_B, 0)), /out of range/);
  assert.throws(() => svc.putChunk('K', 0, 2, chunkOf(FILE_B, 0)), /out of range/);
  assert.throws(() => svc.putChunk('K', 0, 0, Buffer.alloc(10)), /must be/);

  svc.putChunk('K', 0, 0, chunkOf(FILE_B, 0));
  svc.putChunk('K', 0, 0, chunkOf(FILE_B, 0)); // identical retry: no-op
  assert.throws(
    () => svc.putChunk('K', 0, 0, makeBytes(999, CHUNK_SIZE)),
    (e: unknown) => {
      assert.equal((e as UploadError).code, 'CHUNK_CONFLICT');
      return true;
    },
  );

  const res = svc.commit('K');
  assert.equal(res.status, 'incomplete');
  if (res.status === 'incomplete') {
    assert.deepEqual(
      res.missing.map((m) => [m.fileIndex, m.chunkIndex]),
      [[0, 1]],
    );
  }
  // Batch stays open and resumable.
  svc.putChunk('K', 0, 1, chunkOf(FILE_B, 1));
  const done = svc.commit('K');
  assert.equal(done.status, 'committed');
  svc.close();
});

test('out-of-order chunks survive SIGKILL restart; retries and conflicts behave', () => {
  const dir = tmpDir();
  const crash = runScenario('outoforder-a', dir);
  assert.equal(crash.signal, 'SIGKILL');

  const resume = runScenario('outoforder-b', dir);
  assert.equal(resume.status, 0, JSON.stringify(resume));
  const inspect = resume.lines[0] as unknown as {
    accepted: { fileIndex: number; chunkIndex: number }[];
    state: string;
  };
  assert.equal(inspect.state, 'open');
  assert.deepEqual(
    inspect.accepted.map((c) => [c.fileIndex, c.chunkIndex]),
    [
      [0, 0],
      [0, 2],
    ],
  );
  const conflict = resume.lines[1] as unknown as { conflict: string };
  assert.equal(conflict.conflict, 'CHUNK_CONFLICT');
  const commit = resume.lines[2] as unknown as {
    result: { status: string; attachments?: { attachmentId: string; path: string }[] };
  };
  assert.equal(commit.result.status, 'committed');
  const att = commit.result.attachments![0];
  assert.equal(att.attachmentId, `att_${sha256Hex(FILE_A)}`);
  assert.deepEqual(fs.readFileSync(att.path), FILE_A);
});

for (const [name, crashScenario] of [
  ['after staging', 'twofile-crash-after-staging'],
  ['between file publish and commit record', 'twofile-crash-before-record'],
  ['after commit record, before return', 'twofile-crash-after-record'],
] as const) {
  test(`two files: SIGKILL ${name} -> all-or-nothing, stable ids`, () => {
    const dir = tmpDir();
    const crash = runScenario(crashScenario, dir);
    assert.equal(crash.signal, 'SIGKILL');

    const verify = runScenario('twofile-verify', dir);
    assert.equal(verify.status, 0, JSON.stringify(verify));
    const before = verify.lines[0] as unknown as {
      state: string;
      ticketAttachments: unknown[];
      commitResult: unknown;
    };
    const commit = verify.lines[1] as unknown as {
      result: { status: string; attachments?: { attachmentId: string; path: string }[] };
    };
    const again = verify.lines[2] as unknown as {
      result: { status: string; attachments?: { attachmentId: string; path: string }[] };
    };

    if (crashScenario === 'twofile-crash-after-record') {
      // Commit was already effective: reopen must see the terminal state.
      assert.equal(before.state, 'committed');
      assert.equal(before.ticketAttachments.length, 2);
    } else {
      // Commit never recorded: nothing may be published.
      assert.equal(before.state, 'open');
      assert.equal(before.ticketAttachments.length, 0);
    }

    assert.equal(commit.result.status, 'committed');
    const atts = commit.result.attachments!;
    assert.equal(atts.length, 2);
    assert.equal(atts[0].attachmentId, `att_${sha256Hex(FILE_B)}`);
    assert.equal(atts[1].attachmentId, `att_${sha256Hex(FILE_C)}`);
    assert.deepEqual(fs.readFileSync(atts[0].path), FILE_B);
    assert.deepEqual(fs.readFileSync(atts[1].path), FILE_C);

    // Repeated commit returns the identical terminal result.
    assert.deepEqual(again.result, commit.result);

    // Exactly one file per attachment; no leftover chunks/staging.
    assert.equal(attachmentFiles(dir, 'T2').length, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'chunks', 'K2')));
    assert.ok(!fs.existsSync(path.join(dir, 'staging', 'K2')));
  });
}

test('dedup across batches; corrupted re-upload fails; failing batch publishes nothing', () => {
  const dir = tmpDir();

  const first = runScenario('dedup-first', dir);
  assert.equal(first.status, 0);
  const firstCommit = (first.lines[0] as { result: { attachments: { attachmentId: string; path: string }[] } })
    .result;

  const second = runScenario('dedup-second-same-content', dir);
  assert.equal(second.status, 0);
  const secondCommit = (second.lines[0] as { result: { attachments: { attachmentId: string; path: string }[] } })
    .result;

  // Same content in a different batch -> same stable id, same single file.
  assert.deepEqual(secondCommit.attachments, firstCommit.attachments);
  assert.equal(attachmentFiles(dir, 'T3').length, 1);
  assert.deepEqual(fs.readFileSync(firstCommit.attachments[0].path), FILE_D);

  // Corrupted bytes under an already-published declaration must still fail.
  const corrupted = runScenario('dedup-corrupted-reupload', dir);
  assert.equal(corrupted.status, 0);
  const corruptedLine = corrupted.lines[0] as {
    first: { status: string };
    state: string;
    ticketAttachments: unknown[];
  };
  assert.equal(corruptedLine.first.status, 'failed');
  assert.equal(corruptedLine.state, 'failed');
  assert.equal(corruptedLine.ticketAttachments.length, 1);
  assert.deepEqual(fs.readFileSync(firstCommit.attachments[0].path), FILE_D);

  // Batch with one good file and one bad declaration fails as a whole.
  const failing = runScenario('dedup-failing-batch', dir);
  assert.equal(failing.status, 0);
  const line = failing.lines[0] as {
    first: { status: string; reason?: string };
    second: { status: string; reason?: string };
    state: string;
    ticketAttachments: { attachmentId: string }[];
  };
  assert.equal(line.first.status, 'failed');
  assert.match(line.first.reason!, /sha256 mismatch on file 1/);
  // Failure is terminal and repeatable.
  assert.deepEqual(line.second, line.first);
  assert.equal(line.state, 'failed');
  // No new attachments for the ticket (still only the deduped one).
  assert.equal(line.ticketAttachments.length, 1);
  assert.equal(attachmentFiles(dir, 'T3').length, 1);
  // Failed batch artifacts are cleaned.
  assert.ok(!fs.existsSync(path.join(dir, 'chunks', 'D3')));
  assert.ok(!fs.existsSync(path.join(dir, 'staging', 'D3')));
});

test('duplicate content within one batch yields one file and one stable id', () => {
  const dir = tmpDir();
  const r = runScenario('samebatch-dup', dir);
  assert.equal(r.status, 0);
  const commit = (r.lines[0] as { result: { attachments: { attachmentId: string; path: string }[] } })
    .result;
  assert.equal(commit.attachments.length, 2);
  assert.equal(commit.attachments[0].attachmentId, commit.attachments[1].attachmentId);
  assert.equal(commit.attachments[0].path, commit.attachments[1].path);
  assert.equal(attachmentFiles(dir, 'T4').length, 1);
  assert.deepEqual(fs.readFileSync(commit.attachments[0].path), FILE_D);
});

test('reopen sweeps orphans but keeps confirmed chunks of open batches', () => {
  const dir = tmpDir();
  const svc = new ScreenshotUploadService(dir);
  svc.begin('K', 'T', [declOf(FILE_B)]);
  svc.putChunk('K', 0, 0, chunkOf(FILE_B, 0));
  svc.close();

  // Plant orphans: unrecorded chunk, stale staging candidate, stray attachment.
  const orphanChunk = path.join(dir, 'chunks', 'K', '0', '9.part');
  fs.mkdirSync(path.dirname(orphanChunk), { recursive: true });
  fs.writeFileSync(orphanChunk, Buffer.alloc(4));
  const staleStaging = path.join(dir, 'staging', 'K', '0.bin');
  fs.mkdirSync(path.dirname(staleStaging), { recursive: true });
  fs.writeFileSync(staleStaging, Buffer.alloc(4));
  const strayAttachment = path.join(dir, 'attachments', 'T', 'att_stray');
  fs.mkdirSync(path.dirname(strayAttachment), { recursive: true });
  fs.writeFileSync(strayAttachment, Buffer.alloc(4));

  const reopened = new ScreenshotUploadService(dir);
  const insp = reopened.inspect('K');
  // Confirmed chunk survives; orphans are gone and never reported.
  assert.deepEqual(
    insp.acceptedChunks.map((c) => [c.fileIndex, c.chunkIndex]),
    [[0, 0]],
  );
  assert.ok(!fs.existsSync(orphanChunk));
  assert.ok(!fs.existsSync(staleStaging));
  assert.ok(!fs.existsSync(strayAttachment));
  assert.ok(fs.existsSync(path.join(dir, 'chunks', 'K', '0', '0.part')));

  // Batch is still resumable to a correct commit.
  reopened.putChunk('K', 0, 1, chunkOf(FILE_B, 1));
  const res = reopened.commit('K');
  assert.equal(res.status, 'committed');
  reopened.close();
});

test('zero-length file commits correctly', () => {
  const dir = tmpDir();
  const svc = new ScreenshotUploadService(dir);
  const empty = Buffer.alloc(0);
  svc.begin('K', 'T', [declOf(empty)]);
  const res = svc.commit('K');
  assert.equal(res.status, 'committed');
  if (res.status === 'committed') {
    assert.equal(fs.readFileSync(res.attachments[0].path).length, 0);
    assert.equal(res.attachments[0].attachmentId, `att_${sha256Hex(empty)}`);
  }
  svc.close();
});

test('operations on unknown or closed batches are rejected', () => {
  const dir = tmpDir();
  const svc = new ScreenshotUploadService(dir);
  assert.throws(() => svc.inspect('nope'), (e: unknown) => {
    assert.equal((e as UploadError).code, 'BATCH_NOT_FOUND');
    return true;
  });
  assert.throws(() => svc.putChunk('nope', 0, 0, Buffer.alloc(1)), (e: unknown) => {
    assert.equal((e as UploadError).code, 'BATCH_NOT_FOUND');
    return true;
  });
  svc.begin('K', 'T', [declOf(FILE_D)]);
  svc.putChunk('K', 0, 0, chunkOf(FILE_D, 0));
  assert.equal(svc.commit('K').status, 'committed');
  assert.throws(() => svc.putChunk('K', 0, 0, chunkOf(FILE_D, 0)), (e: unknown) => {
    assert.equal((e as UploadError).code, 'BATCH_CLOSED');
    return true;
  });
  svc.close();
});
