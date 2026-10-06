import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex, search } from "../src/index.js";

test("互斥的多词替换：命中 network support，不命中 wireless link", () => {
  const index = buildIndex(
    [{ id: "m1", text: "wifi support" }],
    [
      { left: "wifi", right: "wireless network" },
      { left: "wifi", right: "radio link" },
    ],
  );
  assert.deepEqual(search(index, "network support"), ["m1"]);
  assert.deepEqual(search(index, "wireless link"), []);
  assert.deepEqual(search(index, "wireless network support"), ["m1"]);
  assert.deepEqual(search(index, "radio link"), ["m1"]);
});

test("互不重叠区间：命中 x c 和 a y，不命中 x y", () => {
  const index = buildIndex(
    [{ id: "m1", text: "a b c" }],
    [
      { left: "a b", right: "x" },
      { left: "b c", right: "y" },
    ],
  );
  assert.deepEqual(search(index, "x c"), ["m1"]);
  assert.deepEqual(search(index, "a y"), ["m1"]);
  assert.deepEqual(search(index, "x y"), []);
  assert.deepEqual(search(index, "a b c"), ["m1"]);
});

test("规则双向生效", () => {
  const index = buildIndex(
    [{ id: "m1", text: "wireless network support" }],
    [{ left: "wifi", right: "wireless network" }],
  );
  assert.deepEqual(search(index, "wifi support"), ["m1"]);
});

test("替换结果不会再次触发规则，也不计算传递闭包", () => {
  const index = buildIndex(
    [{ id: "m1", text: "a" }],
    [
      { left: "a", right: "b" },
      { left: "b", right: "c" },
    ],
  );
  assert.deepEqual(search(index, "b"), ["m1"]);
  assert.deepEqual(search(index, "c"), []);
});

test("消息、规则、查询统一小写并按 ASCII 字母数字分词", () => {
  const index = buildIndex(
    [{ id: "m1", text: "WiFi, SUPPORT!" }],
    [{ left: "WIFI", right: "Wireless Network" }],
  );
  assert.deepEqual(search(index, "NETWORK Support"), ["m1"]);
  assert.deepEqual(search(index, "wireless"), ["m1"]);
});

test("查询必须连续出现，不能跳过 token", () => {
  const index = buildIndex([{ id: "m1", text: "a b c" }], []);
  assert.deepEqual(search(index, "a c"), []);
  assert.deepEqual(search(index, "b c"), ["m1"]);
});

test("空查询不命中任何消息", () => {
  const index = buildIndex([{ id: "m1", text: "a b" }], []);
  assert.deepEqual(search(index, "!!!"), []);
});

test("规则每侧超过 3 个 token 时抛错", () => {
  assert.throws(
    () => buildIndex([], [{ left: "a b c d", right: "x" }]),
    RangeError,
  );
});
