import { test } from "node:test";
import * as assert from "node:assert/strict";
import { CHUNK_SIZE, CrashLensStore } from "../src";
import { freshDir, makeFile } from "./helpers";

const TICKET = "ticket-semantics";

test("Begin：相同声明重试取回原批次，变更声明拒绝且不改变原批次", () => {
  const dir = freshDir("begin");
  const store = new CrashLensStore(dir);
  const f = makeFile(100, "semantics:a");
  const decl = [{ size: f.size, sha256: f.sha256 }];

  store.begin("key-1", TICKET, decl);
  // 相同 uploadKey + 相同声明：幂等。
  store.begin("key-1", TICKET, [{ size: f.size, sha256: f.sha256 }]);
  assert.equal(store.inspect("key-1").status, "uploading");

  // 变更声明（不同 ticket / 不同文件集）：拒绝，原批次不变。
  assert.throws(() => store.begin("key-1", "other-ticket", decl), /conflict/);
  assert.throws(() => store.begin("key-1", TICKET, [{ size: f.size + 1, sha256: f.sha256 }]), /conflict/);
  const view = store.inspect("key-1");
  assert.equal(view.status, "uploading");

  // 声明校验：1~5 张、合法摘要。
  assert.throws(() => store.begin("key-empty", TICKET, []), /1 to 5/);
  assert.throws(
    () => store.begin("key-many", TICKET, Array.from({ length: 6 }, () => decl[0])),
    /1 to 5/,
  );
  assert.throws(() => store.begin("key-sha", TICKET, [{ size: 1, sha256: "zz" }]), /sha256/);
  assert.equal(store.inspect("key-empty").status, "unknown");
  store.close();
});

test("Commit 缺块时保持可续传，终结后拒绝继续写分块", () => {
  const dir = freshDir("incomplete");
  const store = new CrashLensStore(dir);
  const f = makeFile(CHUNK_SIZE + 10, "semantics:b");
  store.begin("key-2", TICKET, [{ size: f.size, sha256: f.sha256 }]);

  // 一块都还没传：incomplete，不进入终结态。
  const c0 = store.commit("key-2");
  assert.equal(c0.status, "incomplete");
  if (c0.status !== "incomplete") return;
  assert.deepEqual(c0.missing, [
    { fileIndex: 0, chunkIndex: 0 },
    { fileIndex: 0, chunkIndex: 1 },
  ]);
  assert.equal(store.inspect("key-2").status, "uploading");

  // 传一块后仍缺一块。
  store.putChunk("key-2", 0, 0, Buffer.from(f.chunks[0]));
  const c1 = store.commit("key-2");
  assert.equal(c1.status, "incomplete");
  if (c1.status !== "incomplete") return;
  assert.deepEqual(c1.missing, [{ fileIndex: 0, chunkIndex: 1 }]);

  // 补齐后提交成功；终结后写分块被拒绝。
  store.putChunk("key-2", 0, 1, Buffer.from(f.chunks[1]));
  const c2 = store.commit("key-2");
  assert.equal(c2.status, "committed");
  assert.throws(() => store.putChunk("key-2", 0, 0, Buffer.from(f.chunks[0])), /committed/);

  // 分块尺寸校验：末块必须按实际剩余长度。
  const g = makeFile(CHUNK_SIZE + 10, "semantics:c");
  store.begin("key-3", TICKET, [{ size: g.size, sha256: g.sha256 }]);
  assert.throws(() => store.putChunk("key-3", 0, 1, Buffer.alloc(CHUNK_SIZE)), /expects 10 bytes/);
  assert.throws(() => store.putChunk("key-3", 0, 2, Buffer.alloc(1)), /invalid chunkIndex/);
  store.close();
});

test("未知 uploadKey 的 Inspect 与操作", () => {
  const dir = freshDir("unknown");
  const store = new CrashLensStore(dir);
  const view = store.inspect("nope");
  assert.equal(view.status, "unknown");
  assert.deepEqual(view.acceptedChunks, []);
  assert.deepEqual(view.ticketAttachments, []);
  assert.throws(() => store.putChunk("nope", 0, 0, Buffer.alloc(1)), /unknown uploadKey/);
  assert.throws(() => store.commit("nope"), /unknown uploadKey/);
  store.close();
});
