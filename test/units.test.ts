import assert from "node:assert/strict";
import test from "node:test";
import { haversineMeters, levenshtein, normalizeText, toCodePoints } from "../src/index.js";

test("normalize: NFKC changes length, lowercase, space folding", () => {
  assert.equal(normalizeText("Ⅻ"), "xii"); // 1 code point -> 3 via NFKC
  assert.equal(normalizeText("ＡＢＣ　Ｄ"), "abc d"); // full-width forms + ideographic space
  assert.equal(normalizeText("  Hello   World  "), "hello world");
  assert.equal(normalizeText("Main Street"), "main street"); // NBSP -> ASCII space via NFKC
  assert.equal(normalizeText("a\tb"), "a\tb"); // tab is not folded
  assert.equal(normalizeText("ﬃ"), "ffi"); // ligature expands
});

test("normalize: supplementary plane characters lowercased per code point", () => {
  assert.equal(normalizeText("😀  😀"), "😀 😀");
  assert.equal(normalizeText("𠮷野家"), "𠮷野家");
});

test("code points: supplementary plane counts as one", () => {
  assert.equal(toCodePoints("😀").length, 1);
  assert.equal(toCodePoints("a😀b").length, 3);
  assert.equal("😀".length, 2); // sanity: UTF-16 differs
});

test("levenshtein: basic distances over code points", () => {
  const cp = toCodePoints;
  assert.equal(levenshtein(cp("kitten"), cp("sitting")), 3);
  assert.equal(levenshtein(cp(""), cp("")), 0);
  assert.equal(levenshtein(cp(""), cp("abc")), 3);
  assert.equal(levenshtein(cp("a😀b"), cp("a😃b")), 1);
  assert.equal(levenshtein(cp("😀😀😀"), cp("😀")), 2);
});

test("levenshtein: threshold early exit never returns within-threshold value", () => {
  const cp = toCodePoints;
  assert.equal(levenshtein(cp("kitten"), cp("sitting"), 3), 3);
  assert.ok(levenshtein(cp("kitten"), cp("sitting"), 2) > 2);
  assert.ok(levenshtein(cp("aaaa"), cp("bbbb"), 2) > 2);
  assert.ok(levenshtein(cp("abc"), cp("abcdefghij"), 5) > 5); // length gap
});

test("haversine: known distances and antimeridian", () => {
  assert.equal(haversineMeters(10, 20, 10, 20), 0);
  // 1 degree of longitude at the equator on a 6371000 m sphere.
  assert.ok(Math.abs(haversineMeters(0, 0, 0, 1) - 111194.9266) < 0.01);
  // Across the antimeridian: 0.001 deg apart, ~111 m, not ~40000 km.
  const across = haversineMeters(0, 179.9995, 0, -179.9995);
  assert.ok(across > 100 && across < 120, `across=${across}`);
  const within = haversineMeters(0, 179.9999, 0, -179.9999);
  assert.ok(within < 100, `within=${within}`);
  // Pole to pole is half the circumference.
  assert.ok(Math.abs(haversineMeters(90, 0, -90, 180) - Math.PI * 6371000) < 1);
});
