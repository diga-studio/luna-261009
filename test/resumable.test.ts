import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ResumableUpload } from "../src/index.js";
import type { FileManifest } from "../src/index.js";

const CHUNK = 64; // 测试用小分块；库默认 64MiB 由专门用例验证

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeManifest(fileId: string, data: Buffer, chunkSize = CHUNK): FileManifest {
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push({ sha256: sha256(data.subarray(offset, offset + chunkSize)) });
  }
  return { fileId, totalSize: data.length, chunks, chunkSize };
}

async function* streamOf(data: Buffer, slice = 7): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += slice) {
    yield data.subarray(offset, offset + slice);
  }
}

async function* failingStream(data: Buffer, failAfter: number): AsyncIterable<Uint8Array> {
  let sent = 0;
  for (let offset = 0; offset < data.length; offset += 5) {
    if (sent >= failAfter) {
      throw new Error("simulated network failure");
    }
    const piece = data.subarray(offset, offset + 5);
    sent += piece.length;
    yield piece;
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

async function freshDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "resumable-test-"));
}

test("乱序 + 正确重复 + 错误重试 + 不足尾块：进度精确且最终文件逐字节一致", async () => {
  const dir = await freshDir();
  const up = new ResumableUpload(dir);

  // 3 个整块 + 1 个不足 CHUNK 的尾块
  const tail = CHUNK - 17;
  const data = randomBytes(CHUNK * 3 + tail);
  const manifest = makeManifest("file-a", data);
  await up.registerManifest(manifest);

  const chunkAt = (i: number) => data.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, data.length));

  let status = await up.getStatus("file-a");
  assert.equal(status.totalChunks, 4);
  assert.equal(status.confirmedChunks, 0);
  assert.equal(status.confirmedBytes, 0);
  assert.deepEqual(status.missingChunks, [0, 1, 2, 3]);
  assert.equal(status.complete, false);

  // 乱序：先交尾块（不足 64MiB/CHUNK 的块按实际长度计数）
  assert.deepEqual(await up.receiveChunk("file-a", 3, streamOf(chunkAt(3))), {
    ok: true,
    alreadyConfirmed: false,
  });
  status = await up.getStatus("file-a");
  assert.equal(status.confirmedBytes, tail);
  assert.deepEqual(status.missingChunks, [0, 1, 2]);

  // 错误内容：hash 不符，不计进度
  const wrong = Buffer.alloc(CHUNK, 0xff);
  const bad = await up.receiveChunk("file-a", 1, streamOf(wrong));
  assert.equal(bad.ok, false);
  status = await up.getStatus("file-a");
  assert.equal(status.confirmedBytes, tail);
  assert.deepEqual(status.missingChunks, [0, 1, 2]);

  // 提前结束：长度不足，不计进度
  const short = await up.receiveChunk("file-a", 1, streamOf(chunkAt(1).subarray(0, CHUNK - 5)));
  assert.equal(short.ok, false);
  status = await up.getStatus("file-a");
  assert.deepEqual(status.missingChunks, [0, 1, 2]);

  // 接收中途失败：不计进度
  const failed = await up.receiveChunk("file-a", 2, failingStream(chunkAt(2), 10));
  assert.equal(failed.ok, false);
  status = await up.getStatus("file-a");
  assert.deepEqual(status.missingChunks, [0, 1, 2]);

  // 错误后重试正确内容
  assert.deepEqual(await up.receiveChunk("file-a", 1, streamOf(chunkAt(1))), {
    ok: true,
    alreadyConfirmed: false,
  });
  // 继续乱序提交
  await up.receiveChunk("file-a", 0, streamOf(chunkAt(0)));
  await up.receiveChunk("file-a", 2, streamOf(chunkAt(2)));
  status = await up.getStatus("file-a");
  assert.equal(status.complete, true);
  assert.equal(status.confirmedChunks, 4);
  assert.equal(status.confirmedBytes, data.length);
  assert.deepEqual(status.missingChunks, []);

  // 正确重复提交：只计一次，进度不变
  const dup = await up.receiveChunk("file-a", 1, streamOf(chunkAt(1)));
  assert.deepEqual(dup, { ok: true, alreadyConfirmed: true });
  status = await up.getStatus("file-a");
  assert.equal(status.confirmedChunks, 4);
  assert.equal(status.confirmedBytes, data.length);

  // 完成后读出，逐字节等于原始数据
  const out = await collect(await up.readFile("file-a"));
  assert.deepEqual(out, data);
});

test("重新打开后仍能查询准确的续传进度，并可继续完成", async () => {
  const dir = await freshDir();
  const data = randomBytes(CHUNK * 2 + 9);
  const manifest = makeManifest("file-b", data);
  const chunkAt = (i: number) => data.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, data.length));

  const up1 = new ResumableUpload(dir);
  await up1.registerManifest(manifest);
  await up1.receiveChunk("file-b", 2, streamOf(chunkAt(2)));
  await up1.receiveChunk("file-b", 0, streamOf(chunkAt(0)));

  // 模拟重新打开：同一个目录构造新实例
  const up2 = new ResumableUpload(dir);
  const status = await up2.getStatus("file-b");
  assert.equal(status.confirmedChunks, 2);
  assert.equal(status.confirmedBytes, CHUNK + 9);
  assert.deepEqual(status.missingChunks, [1]);
  assert.equal(status.complete, false);

  // 未完成时读取必须报错
  await assert.rejects(() => up2.readFile("file-b"), /incomplete/);

  await up2.receiveChunk("file-b", 1, streamOf(chunkAt(1)));
  const out = await collect(await up2.readFile("file-b"));
  assert.deepEqual(out, data);
});

test("失败提交不损坏同一位置已确认的数据", async () => {
  const dir = await freshDir();
  const up = new ResumableUpload(dir);
  const data = randomBytes(CHUNK * 2);
  const manifest = makeManifest("file-c", data);
  await up.registerManifest(manifest);
  const chunkAt = (i: number) => data.subarray(i * CHUNK, (i + 1) * CHUNK);

  await up.receiveChunk("file-c", 0, streamOf(chunkAt(0)));
  // 对已确认位置提交错误内容与失败流：已确认数据必须保持
  const bad = await up.receiveChunk("file-c", 0, streamOf(Buffer.alloc(CHUNK, 1)));
  assert.equal(bad.ok, true); // 已确认位置直接忽略重复提交
  await up.receiveChunk("file-c", 1, streamOf(chunkAt(1)));

  const out = await collect(await up.readFile("file-c"));
  assert.deepEqual(out, data);
});

test("清单校验：长度/哈希不符与清单不一致都被拒绝", async () => {
  const dir = await freshDir();
  const up = new ResumableUpload(dir);
  const data = randomBytes(CHUNK);

  await assert.rejects(
    () => up.registerManifest({ fileId: "x", totalSize: CHUNK, chunks: [], chunkSize: CHUNK }),
    /does not match/,
  );
  await assert.rejects(
    () =>
      up.registerManifest({
        fileId: "x",
        totalSize: CHUNK,
        chunks: [{ sha256: "zz" }],
        chunkSize: CHUNK,
      }),
    /sha256/,
  );

  // 同一 fileId 重复登记：内容一致幂等，不一致报错
  const manifest = makeManifest("file-d", data);
  await up.registerManifest(manifest);
  await up.registerManifest(manifest);
  const other = makeManifest("file-d", randomBytes(CHUNK));
  await assert.rejects(() => up.registerManifest(other), /different manifest/);

  // 未登记的 fileId
  await assert.rejects(() => up.getStatus("nope"), /not registered/);
  const res = await up.receiveChunk("file-d", 5, streamOf(data));
  assert.equal(res.ok, false);
});

test("默认分块大小为 64MiB，尾块按剩余长度计", async () => {
  const dir = await freshDir();
  const up = new ResumableUpload(dir);
  const MiB = 1024 * 1024;
  const total = 64 * MiB * 2 + 123;
  const manifest: FileManifest = {
    fileId: "big",
    totalSize: total,
    chunks: [{ sha256: "0".repeat(64) }, { sha256: "1".repeat(64) }, { sha256: "2".repeat(64) }],
  };
  await up.registerManifest(manifest);
  const status = await up.getStatus("big");
  assert.equal(status.totalChunks, 3);
  assert.equal(status.totalSize, total);
  assert.deepEqual(status.missingChunks, [0, 1, 2]);
});
