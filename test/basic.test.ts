import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CHUNK_SIZE,
  ChunkError,
  IntegrityError,
  SessionError,
  UploadStore,
} from "../src/index";
import { dirUsage, makeFakeFile, makeTempDir, removeDir, sha256 } from "./helpers";
import { test } from "./testkit";

test("乱序提交、同序号重传与冲突拒绝", () => {
  const dir = makeTempDir();
  try {
    const file = makeFakeFile(CHUNK_SIZE * 2 + 123); // 3 段，末段较短
    const store = new UploadStore(dir);
    store.begin("s", file.totalBytes, file.sha256);

    // 乱序：2, 0, 1
    store.submitChunk("s", 2, file.chunks[2] as Buffer);
    store.submitChunk("s", 0, file.chunks[0] as Buffer);

    // 同序号同字节重传：成功且不增加持久化副本
    const chunkDir = path.join(dir, "chunks");
    store.submitChunk("s", 0, file.chunks[0] as Buffer);
    store.submitChunk("s", 0, file.chunks[0] as Buffer);
    const sessionDirs = fs.readdirSync(chunkDir);
    assert.strictEqual(sessionDirs.length, 1);
    assert.strictEqual(
      fs.readdirSync(path.join(chunkDir, sessionDirs[0] as string)).length,
      2,
      "重传相同字节不得增加分段文件"
    );

    // 同序号不同字节：拒绝
    const evil = Buffer.from(file.chunks[0] as Buffer);
    evil[0] = (evil[0] as number) ^ 0xff;
    assert.throws(() => store.submitChunk("s", 0, evil), ChunkError);

    // 进度查询
    const p = store.progress("s");
    assert.deepStrictEqual(p.confirmedChunks, [0, 2]);
    assert.strictEqual(p.completed, false);

    store.submitChunk("s", 1, file.chunks[1] as Buffer);
    const ref = store.complete("s");
    assert.strictEqual(ref.size, file.totalBytes);
    assert.ok(fs.readFileSync(ref.path).equals(file.whole), "读回字节必须与原始输入一致");

    // 原数据未被冲突尝试污染
    const p2 = store.progress("s");
    assert.strictEqual(p2.completed, true);
    assert.strictEqual(p2.filePath, ref.path);
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("分段长度与序号校验", () => {
  const dir = makeTempDir();
  try {
    const file = makeFakeFile(CHUNK_SIZE + 10);
    const store = new UploadStore(dir);
    store.begin("s", file.totalBytes, file.sha256);
    assert.throws(
      () => store.submitChunk("s", 0, Buffer.alloc(CHUNK_SIZE - 1)),
      ChunkError,
      "首段必须恰好 5 MiB"
    );
    assert.throws(
      () => store.submitChunk("s", 1, Buffer.alloc(11)),
      ChunkError,
      "末段必须恰好为剩余长度"
    );
    assert.throws(
      () => store.submitChunk("s", 2, Buffer.alloc(1)),
      ChunkError,
      "越界序号拒绝"
    );
    assert.deepStrictEqual(store.progress("s").confirmedChunks, []);
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("会话声明不可改变，重复开始不重置进度", () => {
  const dir = makeTempDir();
  try {
    const file = makeFakeFile(100);
    const other = makeFakeFile(200, 2);
    const store = new UploadStore(dir);
    store.begin("s", file.totalBytes, file.sha256);
    store.submitChunk("s", 0, file.chunks[0] as Buffer);

    assert.throws(
      () => store.begin("s", other.totalBytes, other.sha256),
      SessionError,
      "不同声明必须拒绝"
    );
    assert.throws(() => store.begin("s", file.totalBytes, other.sha256), SessionError);

    store.begin("s", file.totalBytes, file.sha256); // 相同声明：幂等
    assert.deepStrictEqual(
      store.progress("s").confirmedChunks,
      [0],
      "重复开始不得重置进度"
    );

    assert.throws(() => store.begin("", 1, file.sha256), SessionError);
    assert.throws(() => store.begin("x", -1, file.sha256), SessionError);
    assert.throws(() => store.begin("y", 1, "not-a-sha"), SessionError);
    assert.throws(() => store.progress("nobody"), SessionError);
    store.close();
  } finally {
    removeDir(dir);
  }
});


test("完成后的同序号规则与完整文件不可改写", () => {
  const dir = makeTempDir();
  try {
    const file = makeFakeFile(CHUNK_SIZE + 5);
    const store = new UploadStore(dir);
    store.begin("s", file.totalBytes, file.sha256);
    store.submitChunk("s", 0, file.chunks[0] as Buffer);
    store.submitChunk("s", 1, file.chunks[1] as Buffer);
    const ref = store.complete("s");

    // 完成后同序号同字节仍成功
    store.submitChunk("s", 0, file.chunks[0] as Buffer);
    // 完成后同序号不同字节仍拒绝（临时分段已清理，规则不能失效）
    const evil = Buffer.from(file.chunks[0] as Buffer);
    evil[10] = (evil[10] as number) ^ 0xff;
    assert.throws(() => store.submitChunk("s", 0, evil), ChunkError);

    // 完整文件内容未被污染
    assert.ok(fs.readFileSync(ref.path).equals(file.whole));
    // 完整文件只读
    const mode = fs.statSync(ref.path).mode & 0o777;
    assert.strictEqual(mode & 0o222, 0, "完整文件必须只读");
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("两个会话上传相同内容：同一引用且只有一份完整文件", () => {
  const dir = makeTempDir();
  try {
    const file = makeFakeFile(CHUNK_SIZE * 2 + 7);
    const store = new UploadStore(dir);

    store.begin("s1", file.totalBytes, file.sha256);
    store.begin("s2", file.totalBytes, file.sha256);
    for (let i = 0; i < file.chunks.length; i += 1) {
      store.submitChunk("s1", i, file.chunks[i] as Buffer);
      store.submitChunk("s2", i, file.chunks[i] as Buffer);
    }
    const ref1 = store.complete("s1");
    const ref2 = store.complete("s2");
    assert.strictEqual(ref1.path, ref2.path, "同内容必须返回同一引用");
    assert.ok(fs.readFileSync(ref2.path).equals(file.whole));

    const filesUsage = dirUsage(path.join(dir, "files"));
    assert.strictEqual(filesUsage.files, 1, "同内容只保留一份完整文件");
    assert.strictEqual(filesUsage.bytes, file.totalBytes);
    const chunksUsage = dirUsage(path.join(dir, "chunks"));
    assert.strictEqual(chunksUsage.files, 0, "完成后分段副本必须清除");
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("声明校验值已存在但实际字节不匹配的会话不能完成", () => {
  const dir = makeTempDir();
  try {
    const good = makeFakeFile(CHUNK_SIZE + 1, 3);
    const bad = makeFakeFile(CHUNK_SIZE + 1, 4); // 等长但内容不同
    const store = new UploadStore(dir);

    // 先完成 good，使 files/ 中已存在该校验值的完整文件
    store.begin("good", good.totalBytes, good.sha256);
    for (let i = 0; i < good.chunks.length; i += 1) {
      store.submitChunk("good", i, good.chunks[i] as Buffer);
    }
    store.complete("good");

    // evil 会话声明同样的 sha256，但提交的是 bad 的字节
    store.begin("evil", good.totalBytes, good.sha256);
    for (let i = 0; i < bad.chunks.length; i += 1) {
      store.submitChunk("evil", i, bad.chunks[i] as Buffer);
    }
    // 已有同校验值的完整文件也不能绕过本会话的完整性检查
    assert.throws(() => store.complete("evil"), IntegrityError);

    const p = store.progress("evil");
    assert.strictEqual(p.completed, false);
    assert.deepStrictEqual(p.confirmedChunks, [0, 1], "未完成会话的已确认分段必须保留");

    // 未通过校验的内容不得作为完整文件公开
    const filesDir = path.join(dir, "files");
    assert.deepStrictEqual(fs.readdirSync(filesDir), [good.sha256]);
    assert.strictEqual(dirUsage(path.join(dir, "tmp")).files, 0, "拼接半成品必须清除");
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("缺分段不能完成；空文件可直接完成", () => {
  const dir = makeTempDir();
  try {
    const store = new UploadStore(dir);
    const file = makeFakeFile(CHUNK_SIZE * 2);
    store.begin("s", file.totalBytes, file.sha256);
    store.submitChunk("s", 0, file.chunks[0] as Buffer);
    assert.throws(() => store.complete("s"), IntegrityError, "缺分段不得完成");

    const emptySha = sha256(Buffer.alloc(0));
    store.begin("empty", 0, emptySha);
    const ref = store.complete("empty");
    assert.strictEqual(ref.size, 0);
    assert.strictEqual(fs.readFileSync(ref.path).length, 0);
    store.close();
  } finally {
    removeDir(dir);
  }
});
