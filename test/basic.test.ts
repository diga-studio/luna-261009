import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/index.js";

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "kstore-"));
  return { dir, path: join(dir, "knowledge.db") };
}

test("提交版本后可检索，返回原文、版本与分数", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    const v1 = store.submitVersion("kb1", "doc1", [
      { text: "hello world", terms: ["hello", "world"] },
      { text: "hello hello", terms: ["hello", "hello"] },
    ]);
    const hits = store.search(["kb1"], ["hello"]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].text, "hello hello"); // tf 更高，得分更高
    assert.equal(hits[0].versionId, v1);
    assert.equal(hits[0].kbId, "kb1");
    assert.equal(hits[0].docId, "doc1");
    assert.ok(hits[0].score > hits[1].score);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("旧版本不参与检索，回滚后生效，且关闭重开后保持不变", () => {
  const { dir, path } = tempDb();
  try {
    let store = new KnowledgeStore(path);
    const v1 = store.submitVersion("kb1", "doc1", [
      { text: "alpha", terms: ["alpha"] },
    ]);
    const v2 = store.submitVersion("kb1", "doc1", [
      { text: "beta", terms: ["beta"] },
    ]);
    assert.equal(store.search(["kb1"], ["alpha"]).length, 0);
    assert.equal(store.search(["kb1"], ["beta"]).length, 1);

    store.rollback("kb1", "doc1", v1);
    assert.equal(store.search(["kb1"], ["alpha"]).length, 1);
    assert.equal(store.search(["kb1"], ["beta"]).length, 0);

    // 回滚后仍可继续提交新版本
    const v3 = store.submitVersion("kb1", "doc1", [
      { text: "gamma", terms: ["gamma"] },
    ]);
    assert.ok(v3 > v2);
    assert.equal(store.search(["kb1"], ["gamma"]).length, 1);
    store.close();

    // 重新打开：当前版本选择与历史版本保持
    store = new KnowledgeStore(path);
    assert.equal(store.search(["kb1"], ["gamma"]).length, 1);
    assert.equal(store.search(["kb1"], ["alpha"]).length, 0);
    store.rollback("kb1", "doc1", v1);
    assert.equal(store.search(["kb1"], ["alpha"]).length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回滚到不属于该文档的版本会报错", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    const v1 = store.submitVersion("kb1", "doc1", [{ text: "a", terms: ["a"] }]);
    store.submitVersion("kb1", "doc2", [{ text: "b", terms: ["b"] }]);
    assert.throws(() => store.rollback("kb1", "doc2", v1));
    assert.throws(() => store.rollback("kb1", "doc1", 9999));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检索参数约束：超过 10 个知识库报错，空范围/空查询返回空", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    store.submitVersion("kb1", "doc1", [{ text: "a b", terms: ["a", "b"] }]);
    assert.throws(() =>
      store.search(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"], ["a"]),
    );
    assert.deepEqual(store.search([], ["a"]), []);
    assert.deepEqual(store.search(["kb1"], []), []);
    assert.deepEqual(store.search(["kb1"], ["nonexistent"]), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重复查询词只计算一次", () => {
  const { dir, path } = tempDb();
  try {
    const store = new KnowledgeStore(path);
    store.submitVersion("kb1", "doc1", [{ text: "a b", terms: ["a", "b"] }]);
    const once = store.search(["kb1"], ["a", "b"]);
    const twice = store.search(["kb1"], ["a", "a", "b", "b", "b"]);
    assert.deepEqual(twice, once);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
