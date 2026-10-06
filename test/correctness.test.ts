import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { openFunnel, prepareFunnel } from "../src/index";
import { referenceQuery } from "../src/reference";
import { FunnelEvent, StageCounts } from "../src/types";

function ev(
  customer: string,
  journey: string,
  action: string,
  time: number,
  seq: number
): FunnelEvent {
  return { customer, journey, action, time, seq };
}

/** In-memory engine over object events (no persistence). */
function engineFromEvents(events: FunnelEvent[]): {
  query(s: number, e: number): StageCounts;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-test-"));
  prepareFunnel(events, dir);
  return openFunnel(dir);
}

test("basic full chain completes all stages", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "click", 1001, 0),
    ev("c1", "j1", "click", 1002, 0),
    ev("c1", "j1", "conversion", 1003, 0),
  ];
  const db = engineFromEvents(events);
  assert.deepEqual(db.query(0, 2000), [1, 1, 1, 1]);
});

test("same-millisecond events ordered by seq complete stages", () => {
  const events = [
    ev("c1", "j1", "conversion", 1000, 4),
    ev("c1", "j1", "click", 1000, 3),
    ev("c1", "j1", "click", 1000, 2),
    ev("c1", "j1", "impression", 1000, 1),
  ];
  const db = engineFromEvents(events);
  assert.deepEqual(db.query(1000, 1001), [1, 1, 1, 1]);
});

test("same-millisecond events with wrong seq order do not complete", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 4),
    ev("c1", "j1", "click", 1000, 3),
    ev("c1", "j1", "click", 1000, 2),
    ev("c1", "j1", "conversion", 1000, 1),
  ];
  const db = engineFromEvents(events);
  // conversion comes first, then click click impression: no chain beyond
  // stage 1 (the impression itself is inside the window).
  assert.deepEqual(db.query(1000, 1001), [1, 0, 0, 0]);
});

test("window cutting off the prefix impression breaks the chain", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "click", 1001, 0),
    ev("c1", "j1", "click", 1002, 0),
    ev("c1", "j1", "conversion", 1003, 0),
  ];
  const db = engineFromEvents(events);
  // Window excludes the impression: stages need an in-window impression.
  assert.deepEqual(db.query(1001, 2000), [0, 0, 0, 0]);
  // Window excludes the conversion: stages 1-3 complete.
  assert.deepEqual(db.query(1000, 1003), [1, 1, 1, 0]);
});

test("window boundaries are left-closed right-open", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "click", 1001, 0),
    ev("c1", "j1", "click", 1002, 0),
    ev("c1", "j1", "conversion", 1003, 0),
  ];
  const db = engineFromEvents(events);
  // conversion exactly at end is excluded.
  assert.deepEqual(db.query(1000, 1003), [1, 1, 1, 0]);
  // impression exactly at start is included.
  assert.deepEqual(db.query(1000, 1004), [1, 1, 1, 1]);
  // window starting after the impression.
  assert.deepEqual(db.query(1001, 1004), [0, 0, 0, 0]);
});

test("two click stages require two distinct click events", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "click", 1001, 0),
    ev("c1", "j1", "conversion", 1002, 0),
  ];
  const db = engineFromEvents(events);
  assert.deepEqual(db.query(0, 2000), [1, 1, 0, 0]);
});

test("overlapping journeys of one customer cannot be stitched", () => {
  // j1: impression + click; j2 (overlapping in time): click + conversion.
  // Stitching across journeys would complete the funnel; must not count.
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "click", 1001, 0),
    ev("c1", "j2", "click", 1002, 0),
    ev("c1", "j2", "conversion", 1003, 0),
  ];
  const db = engineFromEvents(events);
  assert.deepEqual(db.query(0, 2000), [1, 1, 0, 0]);
});

test("customer completing in multiple journeys counts once", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "click", 1001, 0),
    ev("c1", "j1", "click", 1002, 0),
    ev("c1", "j1", "conversion", 1003, 0),
    ev("c1", "j2", "impression", 2000, 0),
    ev("c1", "j2", "click", 2001, 0),
    ev("c1", "j2", "click", 2002, 0),
    ev("c1", "j2", "conversion", 2003, 0),
  ];
  const db = engineFromEvents(events);
  assert.deepEqual(db.query(0, 3000), [1, 1, 1, 1]);
});

test("unrelated actions may be interspersed", () => {
  const events = [
    ev("c1", "j1", "impression", 1000, 0),
    ev("c1", "j1", "hover", 1001, 0),
    ev("c1", "j1", "click", 1002, 0),
    ev("c1", "j1", "scroll", 1003, 0),
    ev("c1", "j1", "click", 1004, 0),
    ev("c1", "j1", "view", 1005, 0),
    ev("c1", "j1", "conversion", 1006, 0),
  ];
  const db = engineFromEvents(events);
  assert.deepEqual(db.query(0, 2000), [1, 1, 1, 1]);
});

test("stage 2 can use a different impression than stage 4", () => {
  // imp@0 click@1 imp@2 click@3 conv@4: stage 4 chain starts at imp@2
  // (imp@0,click@1,click@3,conv@4 also works). Window [2,5) keeps stage 1-2
  // via imp@2 but the second click is missing inside... construct carefully:
  const events = [
    ev("c1", "j1", "impression", 0, 0),
    ev("c1", "j1", "click", 1, 0),
    ev("c1", "j1", "impression", 2, 0),
    ev("c1", "j1", "click", 3, 0),
    ev("c1", "j1", "conversion", 4, 0),
  ];
  const db = engineFromEvents(events);
  // Full window: full chain exists.
  assert.deepEqual(db.query(0, 5), [1, 1, 1, 1]);
  // Window [1,5): impression@0 excluded, but impression@2,click@3,conversion@4
  // give stages 1-2; stage 3 needs imp,click,click: imp@2,click@3 + one more
  // click -> none inside, so 0.
  assert.deepEqual(db.query(1, 5), [1, 1, 0, 0]);
});

// --- randomized differential testing against the naive reference ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("randomized small datasets match the naive reference", () => {
  const rand = mulberry32(12345);
  const actions = ["impression", "click", "conversion", "hover", "scroll"];
  for (let trial = 0; trial < 30; trial++) {
    const events: FunnelEvent[] = [];
    const customerCount = 1 + Math.floor(rand() * 8);
    const journeyCount = 1 + Math.floor(rand() * 12);
    const eventCount = 1 + Math.floor(rand() * 120);
    for (let i = 0; i < eventCount; i++) {
      events.push(
        ev(
          `c${Math.floor(rand() * customerCount)}`,
          `j${Math.floor(rand() * journeyCount)}`,
          actions[Math.floor(rand() * actions.length)],
          Math.floor(rand() * 60), // heavy time collisions
          Math.floor(rand() * 4)
        )
      );
    }
    const db = engineFromEvents(events);
    let prevS = 0;
    let prevE = 60;
    for (let q = 0; q < 200; q++) {
      // Mix of sliding and random jumps to exercise incremental updates.
      let s: number;
      let e: number;
      if (rand() < 0.5) {
        s = prevS + Math.floor(rand() * 5) - 2;
        e = prevE + Math.floor(rand() * 5) - 2;
      } else {
        s = Math.floor(rand() * 70) - 5;
        e = s + Math.floor(rand() * 70);
      }
      if (e < s) [s, e] = [e, s];
      prevS = s;
      prevE = e;
      const expected = referenceQuery(events, s, e);
      const actual = db.query(s, e);
      assert.deepEqual(
        actual,
        expected,
        `trial ${trial} query [${s}, ${e}) events=${JSON.stringify(events)}`
      );
    }
  }
});

test("prepared data persists and reopens with identical results", () => {
  const rand = mulberry32(999);
  const events: FunnelEvent[] = [];
  const actions = ["impression", "click", "conversion", "hover"];
  for (let i = 0; i < 2000; i++) {
    events.push(
      ev(
        `c${Math.floor(rand() * 50)}`,
        `j${Math.floor(rand() * 200)}`,
        actions[Math.floor(rand() * actions.length)],
        Math.floor(rand() * 10000),
        Math.floor(rand() * 5)
      )
    );
  }
  const queries: [number, number][] = [];
  let s = 1000;
  let e = 5000;
  for (let q = 0; q < 300; q++) {
    s += Math.floor(rand() * 200) - 100;
    e += Math.floor(rand() * 200) - 100;
    if (e <= s) e = s + 1;
    queries.push([s, e]);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-persist-"));
  prepareFunnel(events, dir);

  // In-process reopen.
  const db = openFunnel(dir);
  const expected = queries.map(([qs, qe]) => db.query(qs, qe));
  db.close();
  for (let i = 0; i < queries.length; i++) {
    assert.deepEqual(expected[i], referenceQuery(events, queries[i][0], queries[i][1]));
  }

  // Fresh-process reopen via the CLI helper.
  const queriesFile = path.join(dir, "queries.json");
  const outFile = path.join(dir, "out.json");
  fs.writeFileSync(queriesFile, JSON.stringify(queries));
  execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "reopen-cli.js"),
    dir,
    queriesFile,
    outFile,
  ]);
  const reopened = JSON.parse(fs.readFileSync(outFile, "utf8")) as StageCounts[];
  assert.deepEqual(reopened, expected);
});
