import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, match } from "../src/index.js";

test("关键词与表达式竞争：终点更大者优先，与声明顺序无关", () => {
  const matcher = compile([
    { id: "kw", keywords: ["aa"] },
    { id: "re", patterns: ["(a|aaa)"] },
  ]);
  assert.deepEqual(match(matcher, "aaa"), { branchId: "re", start: 0, end: 3 });
});

test("同区间跨分支竞争：先声明者获胜", () => {
  const matcher = compile([
    { id: "first", keywords: ["aa"] },
    { id: "second", patterns: ["a+"] },
  ]);
  assert.deepEqual(match(matcher, "aa"), { branchId: "first", start: 0, end: 2 });
});

test("起点最小者优先于终点最大者", () => {
  const matcher = compile([
    { id: "late-long", patterns: ["b+"] },
    { id: "early-short", keywords: ["a"] },
  ]);
  assert.deepEqual(match(matcher, "abbb"), { branchId: "early-short", start: 0, end: 1 });
});

test("通配符包含换行，锚点覆盖整条消息，区间按码点计数", () => {
  const matcher = compile([{ id: "any", patterns: ["^.+$"] }]);
  assert.deepEqual(match(matcher, "😀\nx"), { branchId: "any", start: 0, end: 3 });
});

test("只能匹配空串的表达式不产生命中", () => {
  const matcher = compile([{ id: "opt", patterns: ["a?"] }]);
  assert.equal(match(matcher, "😀\nx"), null);
});

test("匹配器无内部状态：结果不受此前处理过的消息影响", () => {
  const full = compile([{ id: "any", patterns: ["^.+$"] }]);
  const opt = compile([{ id: "opt", patterns: ["a?"] }]);
  assert.deepEqual(match(full, "😀\nx"), { branchId: "any", start: 0, end: 3 });
  assert.equal(match(opt, "😀\nx"), null);
  // 交错、重复处理后结果仍然一致。
  assert.deepEqual(match(full, "😀\nx"), { branchId: "any", start: 0, end: 3 });
  assert.equal(match(opt, "😀\nx"), null);
});

test("关键词按字面子串匹配且区分大小写", () => {
  const matcher = compile([
    { id: "lower", keywords: ["Hello"] },
    { id: "dot", keywords: ["a.c"] },
  ]);
  assert.equal(match(matcher, "say hello"), null);
  assert.deepEqual(match(matcher, "say Hello"), { branchId: "lower", start: 4, end: 9 });
  // 关键词中的 '.' 是字面字符，不是通配符。
  assert.equal(match(matcher, "abc"), null);
  assert.deepEqual(match(matcher, "a.c"), { branchId: "dot", start: 0, end: 3 });
});

test("表达式区分大小写，不做 Unicode 规范化", () => {
  const matcher = compile([{ id: "re", patterns: ["Café"] }]);
  assert.equal(match(matcher, "café"), null);
  assert.deepEqual(match(matcher, "Café"), { branchId: "re", start: 0, end: 4 });
  // 组合序列（e + U+0301）不等于预组合字符 é（U+00E9）。
  assert.equal(match(matcher, "Café"), null);
});

test("区间按码点计数：emoji 占一个位置", () => {
  const matcher = compile([{ id: "re", patterns: ["😀+"] }]);
  assert.deepEqual(match(matcher, "x😀😀y"), { branchId: "re", start: 1, end: 3 });
});

test("锚点只匹配整条消息的开头和结尾", () => {
  const matcher = compile([
    { id: "head", patterns: ["^ab"] },
    { id: "tail", patterns: ["ab$"] },
  ]);
  assert.deepEqual(match(matcher, "abxx"), { branchId: "head", start: 0, end: 2 });
  assert.deepEqual(match(matcher, "xxab"), { branchId: "tail", start: 2, end: 4 });
  assert.equal(match(matcher, "xabx"), null);
});

test("字符类、否定类与按码点排序的范围", () => {
  const matcher = compile([
    { id: "digit", patterns: ["[0-9]+"] },
    { id: "vowel", patterns: ["[aeiou]"] },
    { id: "notdigit", patterns: ["[^0-9]"] },
  ]);
  assert.deepEqual(match(matcher, "abc123"), { branchId: "vowel", start: 0, end: 1 });
  assert.deepEqual(match(matcher, "123"), { branchId: "digit", start: 0, end: 3 });
  const onlyNot = compile([{ id: "nd", patterns: ["[^0-9]+"] }]);
  assert.deepEqual(match(onlyNot, "12ab34"), { branchId: "nd", start: 2, end: 4 });
});

test("量词可作用于字符、字符类与嵌套分组", () => {
  const matcher = compile([
    { id: "star", patterns: ["ab*c"] },
    { id: "group", patterns: ["(ab|cd)+e?"] },
    { id: "nested", patterns: ["((a|b)c)+"] },
  ]);
  assert.deepEqual(match(matcher, "abbbc"), { branchId: "star", start: 0, end: 5 });
  assert.deepEqual(match(matcher, "ac"), { branchId: "star", start: 0, end: 2 });
  assert.deepEqual(match(matcher, "abcd"), { branchId: "group", start: 0, end: 4 });
  assert.deepEqual(match(matcher, "acbc"), { branchId: "nested", start: 0, end: 4 });
});

test("反斜杠把语法元字符转义为字面字符", () => {
  const matcher = compile([
    { id: "esc", patterns: ["a\\.c\\(d\\)\\*\\+\\?\\[\\]\\|\\\\\\^\\$"] },
  ]);
  assert.deepEqual(match(matcher, "a.c(d)*+?[]|\\^$"), {
    branchId: "esc",
    start: 0,
    end: 15,
  });
  assert.equal(match(matcher, "abc"), null);
});

test("字符类内也支持转义", () => {
  const matcher = compile([{ id: "cls", patterns: ["[\\]\\-a]+"] }]);
  assert.deepEqual(match(matcher, "]-a"), { branchId: "cls", start: 0, end: 3 });
});

test("零长度命中不参与选择，但能匹配空串的表达式合法", () => {
  // “a*”在“bbb”中只有零长度命中，整体未命中。
  const star = compile([{ id: "star", patterns: ["a*"] }]);
  assert.equal(match(star, "bbb"), null);
  assert.deepEqual(match(star, "aab"), { branchId: "star", start: 0, end: 2 });
  // 可匹配空串的分支（含空选择支）依然能产出非零长度命中。
  const emptyAlt = compile([{ id: "alt", patterns: ["(a|)b"] }]);
  assert.deepEqual(match(emptyAlt, "xb"), { branchId: "alt", start: 1, end: 2 });
  // 空表达式本身合法，只是永远只产生零长度命中。
  const empty = compile([{ id: "empty", patterns: [""] }]);
  assert.equal(match(empty, "abc"), null);
});

test("未命中返回 null；空分支列表也返回 null", () => {
  const matcher = compile([{ id: "kw", keywords: ["zzz"], patterns: ["zzz"] }]);
  assert.equal(match(matcher, "hello"), null);
  assert.equal(match(compile([]), "hello"), null);
  assert.equal(match(compile([{ id: "none" }]), "hello"), null);
});

test("表达式中的选择顺序不影响全局裁决规则", () => {
  // “(aaa|a)”与“(a|aaa)”都应以最大终点取胜，选择支顺序无关。
  const a = compile([{ id: "re", patterns: ["(aaa|a)"] }]);
  const b = compile([{ id: "re", patterns: ["(a|aaa)"] }]);
  assert.deepEqual(match(a, "aaa"), { branchId: "re", start: 0, end: 3 });
  assert.deepEqual(match(b, "aaa"), { branchId: "re", start: 0, end: 3 });
});

test("非法表达式在 compile 时抛出错误", () => {
  const bad = ["(abc", "abc)", "a**", "[a-z", "[z-a]", "\\", "*a", "a|*b"];
  for (const pattern of bad) {
    assert.throws(() => compile([{ id: "x", patterns: [pattern] }]), Error, pattern);
  }
});

test("同一分支内关键词与表达式共同竞争", () => {
  const matcher = compile([{ id: "b", keywords: ["ello"], patterns: ["h.llo"] }]);
  // 关键词起点 1、终点 5；表达式起点 0、终点 5 → 起点最小者胜。
  assert.deepEqual(match(matcher, "hello"), { branchId: "b", start: 0, end: 5 });
});
