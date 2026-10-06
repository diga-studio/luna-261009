import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHUNK_SIZE, CrashLensStore } from "../src";
import { freshDir, makeFile, sha256Of } from "./helpers";

const TICKET = "ticket-dedup";

function uploadAll(store: CrashLensStore, key: string, files: ReturnType<typeof makeFile>[]): void {
  for (let fi = 0; fi < files.length; fi++) {
    for (let ci = 0; ci < files[fi].chunks.length; ci++) {
      store.putChunk(key, fi, ci, Buffer.from(files[fi].chunks[ci]));
    }
  }
}

test("不同批次上传相同内容只保留一份最终文件与稳定标识", () => {
  const dir = freshDir("dedup");
  const store = new CrashLensStore(dir);
  const x = makeFile(CHUNK_SIZE + 50, "dedup:x");

  // 批次 A：上传 X。
  store.begin("key-a", TICKET, [{ size: x.size, sha256: x.sha256 }]);
  uploadAll(store, "key-a", [x]);
  const a = store.commit("key-a");
  assert.equal(a.status, "committed");
  if (a.status !== "committed") return;

  // 批次 B：不同 uploadKey，相同内容。
  store.begin("key-b", TICKET, [{ size: x.size, sha256: x.sha256 }]);
  uploadAll(store, "key-b", [x]);
  const b = store.commit("key-b");
  assert.equal(b.status, "committed");
  if (b.status !== "committed") return;

  // 同一 ticketId + SHA-256：稳定附件标识，且磁盘上只有一份最终文件。
  assert.equal(b.attachments[0].attachmentId, a.attachments[0].attachmentId);
  assert.equal(b.attachments[0].path, a.attachments[0].path);
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 1);

  // 同批次重复内容：两个附件引用同一标识与同一份文件。
  store.begin("key-c", TICKET, [
    { size: x.size, sha256: x.sha256 },
    { size: x.size, sha256: x.sha256 },
  ]);
  uploadAll(store, "key-c", [x, x]);
  const c = store.commit("key-c");
  assert.equal(c.status, "committed");
  if (c.status !== "committed") return;
  assert.equal(c.attachments[0].attachmentId, a.attachments[0].attachmentId);
  assert.equal(c.attachments[1].attachmentId, a.attachments[0].attachmentId);
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 1);
  store.close();
});

test("含摘要错误文件的批次提交失败：整批不发布，不影响已发布附件", () => {
  const dir = freshDir("failure");
  const store = new CrashLensStore(dir);
  const good = makeFile(700, "failure:good");
  const bad = makeFile(900, "failure:bad");
  const established = makeFile(400, "failure:established");

  // 先发布一个既有附件。
  store.begin("key-ok", TICKET, [{ size: established.size, sha256: established.sha256 }]);
  uploadAll(store, "key-ok", [established]);
  const ok = store.commit("key-ok");
  assert.equal(ok.status, "committed");
  if (ok.status !== "committed") return;

  // 失败批次：一个正确文件 + 一个声明摘要错误的文件。
  const wrongSha = sha256Of(Buffer.from("not-the-real-content"));
  store.begin("key-bad", TICKET, [
    { size: good.size, sha256: good.sha256 },
    { size: bad.size, sha256: wrongSha },
  ]);
  uploadAll(store, "key-bad", [good, bad]);
  const failed = store.commit("key-bad");
  assert.equal(failed.status, "failed");
  if (failed.status !== "failed") return;
  assert.match(failed.reason, /file 1 mismatch/);

  // 整批不发布：工单仍只有既有附件；正确文件也未发布。
  const view = store.inspect("key-bad");
  assert.equal(view.status, "failed");
  assert.deepEqual(view.terminalResult, failed);
  assert.equal(view.ticketAttachments.length, 1);
  assert.equal(view.ticketAttachments[0].attachmentId, ok.attachments[0].attachmentId);

  // 失败不可逆：重复 Commit 得到原失败结果；失败批次分块已清理。
  assert.deepEqual(store.commit("key-bad"), failed);
  assert.equal(store.inspect("key-bad").acceptedChunks.length, 0);

  // 此前已发布的附件不受影响，仍可逐字节读回。
  const data: Buffer = fs.readFileSync(ok.attachments[0].path);
  assert.ok(data.equals(established.bytes));
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 1);

  // 重开后失败状态与既有附件依然稳定，失败批次无残留文件。
  store.close();
  const reopened = new CrashLensStore(dir);
  assert.equal(reopened.inspect("key-bad").status, "failed");
  assert.equal(reopened.inspect("key-ok").status, "committed");
  assert.equal(fs.readdirSync(path.join(dir, "chunks")).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, "tmp")).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, "attachments")).length, 1);
  reopened.close();
});
