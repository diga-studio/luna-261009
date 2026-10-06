import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, match } from "../src/index.js";

test("关键字 aa 先声明、表达式 (a|aaa) 后声明：消息 aaa 选后者，区间 [0,3)", () => {
  const m = compile([
    { id: "kw", keywords: ["aa"], patterns: [] },
    { id: "re", keywords: [], patterns: ["(a|aaa)"] },
  ]);
  assert.deepEqual(match(m, "aaa"), { branchId: "re", start: 0, end: 3 });
});

test("同区间跨分支竞争：先声明者胜", () => {
  const m = compile([
    { id: "first", keywords: ["aa"], patterns: [] },
    { id: "second", keywords: [], patterns: ["aa"] },
  ]);
  assert.deepEqual(match(m, "aaa"), { branchId: "first", start: 0, end: 2 });
});

test("😀\\nx：^.+$ 返回 [0,3)，通配符包含换行，位置按码点计", () => {
  const m = compile([{ id: "any", keywords: [], patterns: ["^.+$"] }]);
  assert.deepEqual(match(m, "😀\nx"), { branchId: "any", start: 0, end: 3 });
});

test("仅配置 a? 时消息 😀\\nx 返回 null（零长度命中不参与选择）", () => {
  const m = compile([{ id: "opt", keywords: [], patterns: ["a?"] }]);
  assert.equal(match(m, "😀\nx"), null);
});

test("同一匹配器反复使用，结果不受历史消息影响", () => {
  const m = compile([
    { id: "any", keywords: [], patterns: ["^.+$"] },
    { id: "opt", keywords: [], patterns: ["a?"] },
  ]);
  assert.deepEqual(match(m, "😀\nx"), { branchId: "any", start: 0, end: 3 });
  assert.deepEqual(match(m, "abc"), { branchId: "any", start: 0, end: 3 });
  // 再次处理 😀\nx，结果与首次一致
  assert.deepEqual(match(m, "😀\nx"), { branchId: "any", start: 0, end: 3 });
  const onlyOpt = compile([{ id: "opt", keywords: [], patterns: ["a?"] }]);
  assert.equal(match(onlyOpt, "😀\nx"), null);
  assert.equal(match(onlyOpt, "😀\nx"), null);
});

test("关键字字面子串匹配且区分大小写", () => {
  const m = compile([{ id: "kw", keywords: ["Aa"], patterns: [] }]);
  assert.deepEqual(match(m, "xxAaxx"), { branchId: "kw", start: 2, end: 4 });
  assert.equal(match(m, "xxaaxx"), null);
});

test("起点最小优先于终点最大", () => {
  const m = compile([
    { id: "long", keywords: [], patterns: ["b+"] },
    { id: "early", keywords: [], patterns: ["ab"] },
  ]);
  assert.deepEqual(match(m, "abbb"), { branchId: "early", start: 0, end: 2 });
});

test("字符类、范围与否定类", () => {
  const m = compile([
    { id: "hex", keywords: [], patterns: ["[0-9a-f]+"] },
    { id: "notX", keywords: [], patterns: ["[^x]+"] },
  ]);
  assert.deepEqual(match(m, "z0f9z"), { branchId: "notX", start: 0, end: 5 });
  const hexOnly = compile([{ id: "hex", keywords: [], patterns: ["[0-9a-f]+"] }]);
  assert.deepEqual(match(hexOnly, "g0f9g"), { branchId: "hex", start: 1, end: 4 });
});

test("量词作用于分组", () => {
  const m = compile([{ id: "grp", keywords: [], patterns: ["(ab)+c?"] }]);
  assert.deepEqual(match(m, "xxababz"), { branchId: "grp", start: 2, end: 6 });
  assert.deepEqual(match(m, "abc"), { branchId: "grp", start: 0, end: 3 });
});

test("嵌套分组与选择符", () => {
  const m = compile([{ id: "re", keywords: [], patterns: ["(a(b|c)+d|e)"] }]);
  assert.deepEqual(match(m, "zabcbdz"), { branchId: "re", start: 1, end: 6 });
  assert.deepEqual(match(m, "ze"), { branchId: "re", start: 1, end: 2 });
});

test("转义将元字符作为字面量", () => {
  const m = compile([{ id: "lit", keywords: [], patterns: ["a\\.b\\(c\\)"] }]);
  assert.deepEqual(match(m, "a.b(c)"), { branchId: "lit", start: 0, end: 6 });
  assert.equal(match(m, "aXb(c)"), null);
});

test("锚点只匹配整条消息的开头与结尾", () => {
  const m = compile([
    { id: "head", keywords: [], patterns: ["^ab"] },
    { id: "tail", keywords: [], patterns: ["ab$"] },
  ]);
  assert.deepEqual(match(m, "abx"), { branchId: "head", start: 0, end: 2 });
  assert.deepEqual(match(m, "xab"), { branchId: "tail", start: 1, end: 3 });
  assert.equal(match(m, "xabx"), null);
});

test("码点位置：emoji 之前的命中按码点计数", () => {
  const m = compile([{ id: "kw", keywords: ["x"], patterns: [] }]);
  assert.deepEqual(match(m, "😀😀x"), { branchId: "kw", start: 2, end: 3 });
});

test("未命中返回 null", () => {
  const m = compile([{ id: "kw", keywords: ["hello"], patterns: ["^world$"] }]);
  assert.equal(match(m, "goodbye"), null);
});

test("非法表达式在 compile 时抛出", () => {
  assert.throws(() => compile([{ id: "b", keywords: [], patterns: ["\\d"] }]));
  assert.throws(() => compile([{ id: "b", keywords: [], patterns: ["a**"] }]));
  assert.throws(() => compile([{ id: "b", keywords: [], patterns: ["(a"] }]));
  assert.throws(() => compile([{ id: "b", keywords: [], patterns: ["[z-a]"] }]));
  assert.throws(() => compile([{ id: "b", keywords: [], patterns: ["*a"] }]));
});

test("能匹配空串的合法表达式不被 compile 拒绝", () => {
  const m = compile([{ id: "opt", keywords: [], patterns: ["(a|b)*"] }]);
  assert.deepEqual(match(m, "cab"), { branchId: "opt", start: 1, end: 3 });
  assert.equal(match(m, "ccc"), null);
});
