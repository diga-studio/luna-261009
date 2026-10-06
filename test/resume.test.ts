import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHUNK_SIZE, CrashLensStore } from "../src";
import { expectKilled, freshDir, makeFile, runChild, sha256Of } from "./helpers";

const SIZES = [2 * CHUNK_SIZE + 100, 300];
const SEED = "resume";
const TICKET = "ticket-resume";
const KEY = "upload-resume-1";

test("乱序分块在持久化中断后可续传，重试与冲突语义正确", () => {
  const dir = freshDir("resume");
  const files = SIZES.map((s, i) => makeFile(s, `${SEED}:${i}`));

  // 子进程：乱序提交 4 个分块，第 2 个持久化后被 SIGKILL。
  const order = "1:0,0:2,0:0,0:1";
  const killed = runChild("put_chunks_kill", {
    DIR: dir,
    UPLOAD_KEY: KEY,
    TICKET_ID: TICKET,
    SIZES: SIZES.join(","),
    SEED,
    ORDER: order,
    KILL_AFTER: "2",
  });
  expectKilled(killed);

  // 重开同一存储目录：已确认分块必须仍在。
  const store = new CrashLensStore(dir);
  const before = store.inspect(KEY);
  assert.equal(before.status, "uploading");
  assert.deepEqual(before.acceptedChunks, [
    { fileIndex: 0, chunkIndex: 2 },
    { fileIndex: 1, chunkIndex: 0 },
  ]);
  assert.equal(before.ticketAttachments.length, 0);

  // 相同重试：无副作用，不抛错。
  store.putChunk(KEY, 1, 0, Buffer.from(files[1].chunks[0]));
  store.putChunk(KEY, 0, 2, Buffer.from(files[0].chunks[2]));
  assert.equal(store.inspect(KEY).acceptedChunks.length, 2);

  // 冲突重试：同位置不同字节必须拒绝，且原分块不被覆盖。
  const evil = Buffer.alloc(300, 0xff);
  assert.throws(() => store.putChunk(KEY, 1, 0, evil), /conflict/);
  assert.deepEqual(store.inspect(KEY).acceptedChunks, before.acceptedChunks);

  // 续传剩余分块并提交。
  store.putChunk(KEY, 0, 0, Buffer.from(files[0].chunks[0]));
  store.putChunk(KEY, 0, 1, Buffer.from(files[0].chunks[1]));
  const outcome = store.commit(KEY);
  assert.equal(outcome.status, "committed");
  if (outcome.status !== "committed") return;
  assert.equal(outcome.attachments.length, 2);

  // 已发布附件必须能逐字节读回且与声明摘要一致。
  for (let i = 0; i < 2; i++) {
    const data: Buffer = fs.readFileSync(outcome.attachments[i].path);
    assert.ok(data.equals(files[i].bytes), `attachment ${i} bytes mismatch`);
    assert.equal(sha256Of(data), files[i].sha256);
  }

  // 终结批次的分块已清理；Inspect 与 Commit 幂等。
  assert.equal(store.inspect(KEY).acceptedChunks.length, 0);
  const again = store.commit(KEY);
  assert.deepEqual(again, outcome);
  assert.equal(fs.readdirSync(path.join(dir, "chunks")).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, "tmp")).length, 0);
  store.close();
});
