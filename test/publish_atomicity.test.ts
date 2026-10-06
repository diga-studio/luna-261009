import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHUNK_SIZE, CrashLensStore } from "../src";
import { expectKilled, freshDir, makeFile, runChild, sha256Of } from "./helpers";

const SIZES = [CHUNK_SIZE + 7, 500];
const SEED = "atomicity";
const TICKET = "ticket-atomicity";

function envFor(dir: string, key: string, killPoint: string): Record<string, string> {
  return {
    DIR: dir,
    UPLOAD_KEY: key,
    TICKET_ID: TICKET,
    SIZES: SIZES.join(","),
    SEED,
    KILL_POINT: killPoint,
  };
}

test("文件持久化与批次发布之间中断：无部分发布，重试提交成功", () => {
  const dir = freshDir("between");
  const key = "upload-atomicity-1";
  const files = SIZES.map((s, i) => makeFile(s, `${SEED}:${i}`));

  const killed = runChild("commit_kill", envFor(dir, key, "afterFilePersistBeforePublish"));
  expectKilled(killed);

  const store = new CrashLensStore(dir);
  const view = store.inspect(key);
  // 批次未发布：仍在上传中，工单没有任何新增附件。
  assert.equal(view.status, "uploading");
  assert.equal(view.ticketAttachments.length, 0);
  // 已确认分块全部保留，可续传。
  const totalChunks = files.reduce((n, f) => n + f.chunks.length, 0);
  assert.equal(view.acceptedChunks.length, totalChunks);
  // 发布前崩溃留下的孤儿候选/附件文件已在重开时清理。
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, "tmp")).length, 0);

  // 重试 Commit：不得产生第二组附件，结果稳定。
  const outcome = store.commit(key);
  assert.equal(outcome.status, "committed");
  if (outcome.status !== "committed") return;
  assert.equal(outcome.attachments.length, 2);
  for (let i = 0; i < 2; i++) {
    const data: Buffer = fs.readFileSync(outcome.attachments[i].path);
    assert.ok(data.equals(files[i].bytes));
    assert.equal(sha256Of(data), files[i].sha256);
  }
  assert.deepEqual(store.commit(key), outcome);
  assert.deepEqual(store.inspect(key).terminalResult, outcome);
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 2);
  store.close();
});

test("提交生效后返回前中断：终结结果已持久化，重试得到同一组附件", () => {
  const dir = freshDir("after");
  const key = "upload-atomicity-2";
  const files = SIZES.map((s, i) => makeFile(s, `${SEED}:${i}`));

  const killed = runChild("commit_kill", envFor(dir, key, "afterPublishBeforeReturn"));
  expectKilled(killed);

  const store = new CrashLensStore(dir);
  const view = store.inspect(key);
  // 发布事务已生效：状态与终结结果必须可见。
  assert.equal(view.status, "committed");
  assert.ok(view.terminalResult);
  assert.equal(view.terminalResult!.status, "committed");
  if (view.terminalResult!.status !== "committed") return;
  const first = view.terminalResult!;
  assert.equal(first.attachments.length, 2);
  assert.equal(view.ticketAttachments.length, 2);

  // 重复 Commit 得到原终结结果：相同标识，不出现第二组附件。
  const again = store.commit(key);
  assert.deepEqual(again, first);
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 2);
  assert.equal(store.inspect(key).ticketAttachments.length, 2);

  for (let i = 0; i < 2; i++) {
    const data: Buffer = fs.readFileSync(first.attachments[i].path);
    assert.ok(data.equals(files[i].bytes));
    assert.equal(sha256Of(data), files[i].sha256);
  }
  store.close();
});
