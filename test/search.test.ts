import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, search, tokenize } from "../src/index";

test("tokenize: 转小写并提取 ASCII 字母数字 token", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
  assert.deepEqual(tokenize("WiFi 5GHz 802.11ax"), ["wifi", "5ghz", "802", "11ax"]);
  assert.deepEqual(tokenize("---"), []);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("café au lait"), ["caf", "au", "lait"]);
});

test("场景一: 同词多义替换不得拼接互斥片段", () => {
  const index = buildIndex(
    [{ id: "m1", text: "wifi support" }],
    [
      { left: "wifi", right: "wireless network" },
      { left: "wifi", right: "radio link" },
    ]
  );
  // “wifi” -> “wireless network” 后，“network support” 连续出现。
  assert.deepEqual(search(index, "network support"), ["m1"]);
  // “wireless” 与 “link” 来自两条互斥替换，不得拼接。
  assert.deepEqual(search(index, "wireless link"), []);
  // 其他合法改写也应命中。
  assert.deepEqual(search(index, "wireless network support"), ["m1"]);
  assert.deepEqual(search(index, "radio link support"), ["m1"]);
  assert.deepEqual(search(index, "wifi support"), ["m1"]);
});

test("场景二: 重叠区间不得同时替换", () => {
  const index = buildIndex(
    [{ id: "m1", text: "a b c" }],
    [
      { left: "a b", right: "x" },
      { left: "b c", right: "y" },
    ]
  );
  assert.deepEqual(search(index, "x c"), ["m1"]);
  assert.deepEqual(search(index, "a y"), ["m1"]);
  // “x y” 需要两个重叠区间同时替换，非法。
  assert.deepEqual(search(index, "x y"), []);
  assert.deepEqual(search(index, "a b c"), ["m1"]);
});

test("规则双向生效", () => {
  const index = buildIndex(
    [
      { id: "m1", text: "wifi support" },
      { id: "m2", text: "wireless network support" },
    ],
    [{ left: "wifi", right: "wireless network" }]
  );
  assert.deepEqual(search(index, "wireless network support"), ["m1", "m2"]);
  assert.deepEqual(search(index, "wifi support"), ["m1", "m2"]);
});

test("替换结果不能再次触发规则（无传递闭包）", () => {
  const index = buildIndex(
    [{ id: "m1", text: "wifi" }],
    [
      { left: "wifi", right: "wireless network" },
      { left: "network", right: "lan" },
    ]
  );
  // “wifi” -> “wireless network” 合法。
  assert.deepEqual(search(index, "wireless network"), ["m1"]);
  // “wireless lan” 需要对替换结果再套用规则，非法。
  assert.deepEqual(search(index, "wireless lan"), []);
});

test("查询自身不扩展", () => {
  const index = buildIndex(
    [{ id: "m1", text: "wifi" }],
    [{ left: "wifi", right: "wireless network" }]
  );
  // 查询 “wireless” 命中改写 “wireless network” 的前缀部分。
  assert.deepEqual(search(index, "wireless"), ["m1"]);
  // 查询 “network wifi” 在任何改写中都不连续。
  assert.deepEqual(search(index, "network wifi"), []);
});

test("允许完全不替换", () => {
  const index = buildIndex(
    [{ id: "m1", text: "plain message here" }],
    [{ left: "plain", right: "simple" }]
  );
  assert.deepEqual(search(index, "message here"), ["m1"]);
  assert.deepEqual(search(index, "simple message"), ["m1"]);
});

test("匹配可从替换结果内部开始或结束", () => {
  const index = buildIndex(
    [{ id: "m1", text: "go wifi now" }],
    [{ left: "wifi", right: "fast wireless network" }]
  );
  assert.deepEqual(search(index, "wireless network"), ["m1"]);
  assert.deepEqual(search(index, "go fast"), ["m1"]);
  assert.deepEqual(search(index, "network now"), ["m1"]);
  assert.deepEqual(search(index, "fast wireless network"), ["m1"]);
});

test("不能跳过 token", () => {
  const index = buildIndex([{ id: "m1", text: "a b c" }], []);
  assert.deepEqual(search(index, "a c"), []);
  assert.deepEqual(search(index, "a b"), ["m1"]);
});

test("查询与消息统一分词和大小写", () => {
  const index = buildIndex([{ id: "m1", text: "WiFi Support!" }], []);
  assert.deepEqual(search(index, "WIFI support"), ["m1"]);
  assert.deepEqual(search(index, "wifi, support"), ["m1"]);
});

test("空 token 查询不命中任何消息", () => {
  const index = buildIndex([{ id: "m1", text: "hello" }], []);
  assert.deepEqual(search(index, "!!!"), []);
  assert.deepEqual(search(index, ""), []);
});

test("多条消息只返回命中的 id", () => {
  const index = buildIndex(
    [
      { id: "m1", text: "wifi support" },
      { id: "m2", text: "wired ethernet" },
      { id: "m3", text: "wireless network help" },
    ],
    [{ left: "wifi", right: "wireless network" }]
  );
  assert.deepEqual(search(index, "wireless network"), ["m1", "m3"]);
  assert.deepEqual(search(index, "ethernet"), ["m2"]);
});

test("规则两侧 token 数必须在 1-3 之间", () => {
  assert.throws(() =>
    buildIndex([], [{ left: "one two three four", right: "x" }])
  );
  assert.throws(() => buildIndex([], [{ left: "!!!", right: "x" }]));
  const ok = buildIndex([], [{ left: "one two three", right: "x" }]);
  assert.deepEqual(search(ok, "x"), []);
});

test("索引构建后不变", () => {
  const index = buildIndex(
    [{ id: "m1", text: "wifi" }],
    [{ left: "wifi", right: "wireless network" }]
  );
  assert.equal(Object.isFrozen(index), true);
  assert.equal(Object.isFrozen(index.messages), true);
  assert.equal(Object.isFrozen(index.rules), true);
  assert.equal(Object.isFrozen(index.messages[0].tokens), true);
  // 检索不修改索引，重复检索结果一致。
  assert.deepEqual(search(index, "wireless network"), ["m1"]);
  assert.deepEqual(search(index, "wireless network"), ["m1"]);
});
