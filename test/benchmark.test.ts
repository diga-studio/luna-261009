import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../bench/run";

// Full-scale acceptance benchmark: 10M events / 500K customers / 2M journeys,
// 100 warmup + 10000 timed queries after a fresh-process reopen.
// Set BENCH_SCALE=smoke for a quick local run.
test("full-scale benchmark meets latency/RSS targets and matches full computation", { timeout: 1_200_000 }, () => {
  const pass = run();
  assert.equal(pass, true, "benchmark targets not met (see report above)");
});
