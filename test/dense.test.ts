import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cluster, normalizeText } from "../src/index.js";
import type { EntityRecord } from "../src/index.js";
import { canonicalize, idsOf, mkRecord, mulberry32, shuffled } from "./helpers.js";

const GROUPS = 1000;
const VARIANTS = 10; // original + 9 single-position replacements
const EVAL_LIMIT = 200000;

function buildRecords(): { records: EntityRecord[]; expected: string[][] } {
  const records: EntityRecord[] = [];
  const expected: string[][] = [];
  for (let i = 0; i < GROUPS; i++) {
    const hex = createHash("sha256").update(`entity:${i}`).digest("hex");
    const titles = [hex];
    for (let j = 0; j < 9; j++) {
      titles.push(hex.slice(0, j) + "z" + hex.slice(j + 1));
    }
    const ids: string[] = [];
    titles.forEach((title, k) => {
      const id = `g${i}v${k}`;
      ids.push(id);
      records.push(mkRecord(id, title, "1 infinite loop, cupertino", 37.3318, -122.0312));
    });
    expected.push(ids);
  }
  return { records, expected };
}

test("dense: 1000 sha256 groups x 10 records cluster exactly within eval budget", () => {
  const { records, expected } = buildRecords();
  assert.equal(records.length, 10000);

  // Normalized titles are pairwise distinct.
  const normalized = new Set(records.map((r) => normalizeText(r.title)));
  assert.equal(normalized.size, records.length);

  const rand = mulberry32(20261009);
  const input = shuffled(records, rand);

  const result = cluster(input);
  assert.equal(result.clusters.length, GROUPS);
  for (const c of result.clusters) assert.equal(c.length, VARIANTS);
  assert.deepEqual(idsOf(result.clusters), canonicalize(expected));
  assert.ok(
    result.distanceEvaluations <= EVAL_LIMIT,
    `distanceEvaluations=${result.distanceEvaluations} exceeds ${EVAL_LIMIT}`,
  );

  // A different shuffle must yield the same partition (order independence).
  const input2 = shuffled(records, mulberry32(777));
  const result2 = cluster(input2);
  assert.deepEqual(idsOf(result2.clusters), canonicalize(expected));
  assert.ok(result2.distanceEvaluations <= EVAL_LIMIT);
});
