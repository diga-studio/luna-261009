import assert from "node:assert/strict";
import test from "node:test";
import { cluster, isDuplicate } from "../src/index.js";
import type { EntityRecord } from "../src/index.js";
import {
  bruteForceClusters,
  canonicalize,
  idsOf,
  mkRecord,
  mulberry32,
  shuffled,
} from "./helpers.js";

const ADDR = "1 main street";
const LAT = 37.7749;
const LON = -122.4194;

function assertSamePartition(actual: readonly EntityRecord[][], expected: string[][]): void {
  assert.deepEqual(idsOf(actual), canonicalize(expected));
}

function checkAgainstBruteForce(records: EntityRecord[], seeds: number[]): void {
  const expected = bruteForceClusters(records);
  for (const seed of seeds) {
    const rand = mulberry32(seed);
    const shuffledRecords = shuffled(records, rand);
    const result = cluster(shuffledRecords);
    assert.deepEqual(
      idsOf(result.clusters),
      expected,
      `partition mismatch for seed ${seed}`,
    );
    // Every input record appears exactly once (singletons preserved).
    assert.equal(result.clusters.flat().length, records.length);
  }
}

test("chain A-B-C: transitive duplicates share a cluster", () => {
  // d(A,B)=5, d(B,C)=5, d(A,C)=10 > 9 (max allowed for L=64).
  const a = mkRecord("A", "a".repeat(64), ADDR, LAT, LON);
  const b = mkRecord("B", "bbbbb" + "a".repeat(59), ADDR, LAT, LON);
  const c = mkRecord("C", "bbbbb" + "ccccc" + "a".repeat(54), ADDR, LAT, LON);
  assert.ok(isDuplicate(a, b));
  assert.ok(isDuplicate(b, c));
  assert.ok(!isDuplicate(a, c));
  assertSamePartition(cluster([c, b, a]).clusters, [["A", "B", "C"]]);
});

test("pairs satisfying only two of three conditions are not duplicates", () => {
  const t1 = "alpha beta gamma delta";
  const t2 = "alpha beta gamma deltax"; // similar titles
  const far = mkRecord("F", t1, ADDR, LAT + 1, LON); // same strings, ~111 km away
  const near1 = mkRecord("N1", t1, ADDR, LAT, LON);
  const near2 = mkRecord("N2", t2, ADDR, LAT, LON);
  const otherAddr = mkRecord("N3", t1, "completely different address 999", LAT, LON);
  const otherTitle = mkRecord("N4", "zzzz qqqq wwww eeee rrrr", ADDR, LAT, LON);

  assert.ok(!isDuplicate(near1, far)); // geo fails
  assert.ok(!isDuplicate(near1, otherAddr)); // address fails
  assert.ok(!isDuplicate(near1, otherTitle)); // title fails
  assert.ok(isDuplicate(near1, near2)); // all three hold

  const records = [far, near1, near2, otherAddr, otherTitle];
  checkAgainstBruteForce(records, [1, 2, 3]);
  assertSamePartition(cluster(records).clusters, [["F"], ["N1", "N2"], ["N3"], ["N4"]]);
});

test("85% threshold boundary: 20d <= 3L on both sides", () => {
  // L = 20: d = 3 -> 60 <= 60 similar; d = 4 -> 80 > 60 not similar.
  const base20 = "a".repeat(20);
  const sim3 = mkRecord("S3", "bbb" + "a".repeat(17), ADDR, LAT, LON);
  const sim4 = mkRecord("S4", "bbbb" + "a".repeat(16), ADDR, LAT, LON);
  const base = mkRecord("B", base20, ADDR, LAT, LON);
  assert.ok(isDuplicate(base, sim3));
  assert.ok(!isDuplicate(base, sim4));

  // L = 64: d = 9 -> 180 <= 192 similar; d = 10 -> 200 > 192 not similar.
  const base64 = mkRecord("B64", "x".repeat(64), ADDR, LAT, LON);
  const sim9 = mkRecord("S9", "y".repeat(9) + "x".repeat(55), ADDR, LAT, LON);
  const sim10 = mkRecord("S10", "y".repeat(10) + "x".repeat(54), ADDR, LAT, LON);
  assert.ok(isDuplicate(base64, sim9));
  assert.ok(!isDuplicate(base64, sim10));

  checkAgainstBruteForce([base, sim3, sim4, base64, sim9, sim10], [11, 12]);
});

test("NFKC normalization changes string length but still matches", () => {
  const roman = mkRecord("R", "Ⅻ", ADDR, LAT, LON); // NFKC -> "XII" -> "xii"
  const ascii = mkRecord("A", "xii", ADDR, LAT, LON);
  assert.ok(isDuplicate(roman, ascii));
  const fullwidth = mkRecord("W", "ＡＢＣ １２３", "Ｍａｉｎ　Ｓｔｒｅｅｔ", LAT, LON);
  const plain = mkRecord("P", "abc 123", "main street", LAT, LON);
  assert.ok(isDuplicate(fullwidth, plain));
  checkAgainstBruteForce([roman, ascii, fullwidth, plain], [21]);
});

test("supplementary plane characters count as single code points", () => {
  // 10 emoji + 10 ascii = 20 code points; 3 emoji swapped -> d = 3.
  // Code-point math: 20*3 <= 3*20 -> similar. UTF-16 math (L=40, d=6)
  // would give 120 > 90 -> not similar; the code-point result is required.
  const e1 = mkRecord("E1", "😀".repeat(10) + "a".repeat(10), ADDR, LAT, LON);
  const e2 = mkRecord("E2", "😁😁😁" + "😀".repeat(7) + "a".repeat(10), ADDR, LAT, LON);
  assert.ok(isDuplicate(e1, e2));
  const e3 = mkRecord("E3", "😂😂😂😂" + "😀".repeat(6) + "a".repeat(10), ADDR, LAT, LON);
  assert.ok(!isDuplicate(e1, e3)); // d = 4, 80 > 60
  checkAgainstBruteForce([e1, e2, e3], [31]);
});

test("antimeridian: longitudes near +/-180 within 100 m are duplicates", () => {
  const west = mkRecord("W", "pacific store", ADDR, 0.0, 179.9999);
  const east = mkRecord("E", "pacific store", ADDR, 0.0, -179.9999);
  assert.ok(isDuplicate(west, east)); // ~22 m across the antimeridian
  const westFar = mkRecord("WF", "pacific store", ADDR, 0.0, 179.999);
  const eastFar = mkRecord("EF", "pacific store", ADDR, 0.0, -179.999);
  assert.ok(!isDuplicate(westFar, eastFar)); // ~222 m
  checkAgainstBruteForce([west, east, westFar, eastFar], [41]);
});

test("repeated substrings and identical titles across locations", () => {
  const rep1 = mkRecord("R1", "ab".repeat(32), ADDR, LAT, LON);
  const rep2 = mkRecord("R2", "ab".repeat(31) + "ac", ADDR, LAT, LON); // d = 1
  const rep3 = mkRecord("R3", "ab".repeat(32), ADDR, LAT + 0.5, LON); // same title, far away
  const rep4 = mkRecord("R4", "ba".repeat(32), ADDR, LAT, LON); // d = 2 from R1
  assert.ok(isDuplicate(rep1, rep2));
  assert.ok(!isDuplicate(rep1, rep3));
  assert.ok(isDuplicate(rep1, rep4));
  const records = [rep1, rep2, rep3, rep4];
  checkAgainstBruteForce(records, [51, 52, 53]);
  assertSamePartition(cluster(records).clusters, [["R1", "R2", "R4"], ["R3"]]);
});

test("empty input and singleton input", () => {
  assert.deepEqual(cluster([]), { clusters: [], distanceEvaluations: 0 });
  const one = cluster([mkRecord("X", "solo", ADDR, LAT, LON)]);
  assertSamePartition(one.clusters, [["X"]]);
  assert.equal(one.distanceEvaluations, 0);
});

test("short titles (fewer than 10 code points) still cluster exactly", () => {
  const s1 = mkRecord("S1", "cafe", ADDR, LAT, LON);
  const s2 = mkRecord("S2", "café", ADDR, LAT, LON); // é vs e: d = 1, L = 4 -> 20 <= 12? no
  const s3 = mkRecord("S3", "cafe", ADDR, LAT, LON);
  assert.ok(!isDuplicate(s1, s2)); // 20*1 = 20 > 3*4 = 12
  assert.ok(isDuplicate(s1, s3));
  const ab1 = mkRecord("T1", "abcdefghij", ADDR, LAT, LON);
  const ab2 = mkRecord("T2", "abcdefghiz", ADDR, LAT, LON); // d = 1, L = 10 -> 20 <= 30 yes
  assert.ok(isDuplicate(ab1, ab2));
  checkAgainstBruteForce([s1, s2, s3, ab1, ab2], [61, 62]);
});

test("randomized cross-check against brute force", () => {
  const rand = mulberry32(99);
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const records: EntityRecord[] = [];
  for (let i = 0; i < 60; i++) {
    const w = () => words[Math.floor(rand() * words.length)]!;
    const title = `${w()} ${w()} ${w()}${rand() < 0.3 ? "x" : ""}`;
    const address = `${Math.floor(rand() * 5)} ${w()} street`;
    const lat = LAT + Math.floor(rand() * 3) * 0.0005;
    const lon = LON + Math.floor(rand() * 3) * 0.0005;
    records.push(mkRecord(`id${i}`, title, address, lat, lon));
  }
  checkAgainstBruteForce(records, [1, 2, 3, 4, 5]);
});
