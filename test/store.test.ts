import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CHUNK_SIZE, ResumableStore } from "../src/index.js";
import type { FileManifest } from "../src/index.js";

const CHUNK = 4; // 测试用小分块，布局逻辑与 64MiB 完全一致

test("默认分块大小为 64MiB", () => {
  assert.equal(DEFAULT_CHUNK_SIZE, 64 * 1024 * 1024);
});

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildManifest(fileId: string, data: Uint8Array): FileManifest {
  const chunkHashes: string[] = [];
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    chunkHashes.push(sha256(data.subarray(offset, offset + CHUNK)));
  }
  return { fileId, totalSize: data.length, chunkHashes };
}

function chunkOf(data: Uint8Array, index: number): Uint8Array {
  return data.subarray(index * CHUNK, Math.min(data.length, (index + 1) * CHUNK));
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of iterable) parts.push(part);
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

async function makeStore(): Promise<{ store: ResumableStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "resumable-"));
  return { store: new ResumableStore({ dir, chunkSize: CHUNK }), dir };
}

/** 中途报错的数据流，模拟接收失败。 */
async function* failingStream(
  data: Uint8Array,
  failAfterBytes: number,
): AsyncIterable<Uint8Array> {
  yield data.subarray(0, failAfterBytes);
  throw new Error("connection reset");
}

test("乱序提交：进度精确，尾块按实际长度计数", async () => {
  const { store } = await makeStore();
  const data = randomBytes(14); // 4+4+4+2，尾块不足一个分块
  const manifest = buildManifest("f1", data);
  await store.registerFile(manifest);

  for (const index of [2, 0, 3]) {
    const r = await store.receiveChunk("f1", index, chunkOf(data, index));
    assert.deepEqual(r, { accepted: true, duplicate: false });
  }

  const status = await store.getStatus("f1");
  assert.equal(status.totalChunks, 4);
  assert.equal(status.confirmedChunks, 3);
  assert.equal(status.confirmedBytes, 4 + 4 + 2); // 尾块 2 字节
  assert.deepEqual(status.missingChunks, [1]);
  assert.equal(status.complete, false);

  await store.receiveChunk("f1", 1, chunkOf(data, 1));
  const done = await store.getStatus("f1");
  assert.equal(done.complete, true);
  assert.equal(done.confirmedBytes, 14);
});

test("正确重复提交只计入一次，且不改动已确认数据", async () => {
  const { store } = await makeStore();
  const data = randomBytes(8);
  await store.registerFile(buildManifest("f2", data));

  await store.receiveChunk("f2", 0, chunkOf(data, 0));
  const dup = await store.receiveChunk("f2", 0, chunkOf(data, 0));
  assert.deepEqual(dup, { accepted: true, duplicate: true });

  // 重复位置提交错误内容：不得损坏已确认数据
  const bad = await store.receiveChunk("f2", 0, randomBytes(4));
  assert.equal(bad.duplicate, true);

  const status = await store.getStatus("f2");
  assert.equal(status.confirmedChunks, 1);
  assert.equal(status.confirmedBytes, 4);

  await store.receiveChunk("f2", 1, chunkOf(data, 1));
  assert.deepEqual(await collect(store.readFile("f2")), data);
});

test("错误内容、提前结束、超长输入均不增加进度", async () => {
  const { store } = await makeStore();
  const data = randomBytes(8);
  await store.registerFile(buildManifest("f3", data));

  // 长度正确但内容错误（哈希不符）
  const wrongContent = await store.receiveChunk("f3", 0, randomBytes(4));
  assert.equal(wrongContent.accepted, false);
  assert.match(wrongContent.reason!, /sha256/);

  // 提前结束（长度不足）
  const short = await store.receiveChunk("f3", 0, data.subarray(0, 2));
  assert.equal(short.accepted, false);
  assert.match(short.reason!, /size mismatch/);

  // 超长输入
  const long = await store.receiveChunk("f3", 0, randomBytes(10));
  assert.equal(long.accepted, false);

  const status = await store.getStatus("f3");
  assert.equal(status.confirmedChunks, 0);
  assert.equal(status.confirmedBytes, 0);
  assert.deepEqual(status.missingChunks, [0, 1]);

  // 错误重试后提交正确数据可确认
  const ok = await store.receiveChunk("f3", 0, chunkOf(data, 0));
  assert.equal(ok.accepted, true);
  assert.equal((await store.getStatus("f3")).confirmedBytes, 4);
});

test("接收中途失败：不增加进度，不损坏已确认数据", async () => {
  const { store } = await makeStore();
  const data = randomBytes(8);
  await store.registerFile(buildManifest("f4", data));

  await store.receiveChunk("f4", 0, chunkOf(data, 0));

  const failed = await store.receiveChunk("f4", 1, failingStream(chunkOf(data, 1), 2));
  assert.equal(failed.accepted, false);
  assert.match(failed.reason!, /connection reset/);

  const status = await store.getStatus("f4");
  assert.equal(status.confirmedChunks, 1);
  assert.deepEqual(status.missingChunks, [1]);

  // 重试成功，最终文件逐字节一致
  await store.receiveChunk("f4", 1, Readable.from([chunkOf(data, 1)]));
  assert.deepEqual(await collect(store.readFile("f4")), data);
});

test("重新打开后仍能查询准确的续传进度", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resumable-"));
  const data = randomBytes(14);
  const manifest = buildManifest("f5", data);

  const store1 = new ResumableStore({ dir, chunkSize: CHUNK });
  await store1.registerFile(manifest);
  await store1.receiveChunk("f5", 3, chunkOf(data, 3));
  await store1.receiveChunk("f5", 0, chunkOf(data, 0));

  // 模拟重新打开：全新实例，同一目录
  const store2 = new ResumableStore({ dir, chunkSize: CHUNK });
  await store2.registerFile(manifest);
  const status = await store2.getStatus("f5");
  assert.equal(status.confirmedChunks, 2);
  assert.equal(status.confirmedBytes, 4 + 2);
  assert.deepEqual(status.missingChunks, [1, 2]);

  // 冲突的清单必须被拒绝
  const other = buildManifest("f5", randomBytes(14));
  await assert.rejects(store2.registerFile(other), /conflicting manifest/);

  // 续传剩余分块后可读出完整文件
  await store2.receiveChunk("f5", 1, chunkOf(data, 1));
  await store2.receiveChunk("f5", 2, chunkOf(data, 2));
  assert.deepEqual(await collect(store2.readFile("f5")), data);

  await rm(dir, { recursive: true, force: true });
});

test("未完成时禁止读取完成文件", async () => {
  const { store } = await makeStore();
  const data = randomBytes(8);
  await store.registerFile(buildManifest("f6", data));
  await store.receiveChunk("f6", 0, chunkOf(data, 0));
  await assert.rejects(async () => {
    for await (const _ of store.readFile("f6")) {
      // 应在进入迭代时抛错
    }
  }, /incomplete/);
});

test("混合场景：乱序 + 正确重复 + 错误重试 + 不足分块的尾块", async () => {
  const { store } = await makeStore();
  const data = randomBytes(22); // 4*5+2，6 个分块，尾块 2 字节
  const manifest = buildManifest("mix", data);
  await store.registerFile(manifest);

  // 乱序 + 穿插错误与重复
  await store.receiveChunk("mix", 5, chunkOf(data, 5)); // 尾块先到
  await store.receiveChunk("mix", 5, chunkOf(data, 5)); // 正确重复
  await store.receiveChunk("mix", 2, randomBytes(4)); // 错误内容
  await store.receiveChunk("mix", 0, failingStream(chunkOf(data, 0), 1)); // 接收失败
  await store.receiveChunk("mix", 3, chunkOf(data, 3));
  await store.receiveChunk("mix", 2, chunkOf(data, 2)); // 错误后重试成功
  await store.receiveChunk("mix", 1, data.subarray(4, 6)); // 提前结束
  await store.receiveChunk("mix", 1, chunkOf(data, 1));
  await store.receiveChunk("mix", 4, chunkOf(data, 4));
  await store.receiveChunk("mix", 0, chunkOf(data, 0)); // 失败后重试成功

  const status = await store.getStatus("mix");
  assert.equal(status.complete, true);
  assert.equal(status.confirmedChunks, 6);
  assert.equal(status.confirmedBytes, 22);
  assert.deepEqual(status.missingChunks, []);

  assert.deepEqual(await collect(store.readFile("mix")), data);
});
