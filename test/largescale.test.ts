import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StepIndex } from "../src/index.js";

const N = 1_000_000;
const MIB = 1024 * 1024;

function chainRef(i: number): number {
  return (i % N) + 1;
}
function hashRef(i: number): number {
  return ((i * 7 + 13) % N) + 1;
}
function pseudoRef(i: number): number {
  return ((i * 31 + 17) % N) + 1;
}
function modInverse(a: number, m: number): number {
  let [old_r, r] = [a % m, m];
  let [old_s, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(old_r / r);
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}
const INV7 = modInverse(7, N);
function hashRefInverse(target: number): number {
  // hash(j) = ((j*7+13) % N) + 1 = target  =>  j = ((target-1-13) * INV7) mod N
  return (((target - 1 - 13) * INV7) % N + N) % N;
}
function chainRefInverse(target: number): number {
  return target === 1 ? N : target - 1;
}

function recordFor(i: number): string {
  const pad = "x".repeat(48);
  return (
    `#${i}=PART${i}('name #${pseudoRef(i)} ENDSEC; ${pad}',` +
    `-${i}.25,#${chainRef(i)},#${hashRef(i)});\n`
  );
}

function expectedForward(i: number): string[] {
  return [...new Set([chainRef(i), hashRef(i)])].sort((a, b) => a - b).map(String);
}
function expectedBackward(i: number): string[] {
  return [...new Set([chainRefInverse(i), hashRefInverse(i)])]
    .sort((a, b) => a - b)
    .map(String);
}

if (process.env.STEPIDX_BIG_CHILD !== "1") {
  // Parent: re-run this file in a child process with a bounded V8 young
  // generation, then check the peak RSS the child reports.
  test("100MiB+ generated import (memory-bounded child)", { timeout: 600_000 }, () => {
    const res = spawnSync(
      process.execPath,
      ["--max-semi-space-size=8", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, STEPIDX_BIG_CHILD: "1" },
        encoding: "utf8",
        timeout: 590_000,
      },
    );
    assert.equal(res.status, 0, res.stderr);
    const m = /peak RSS: ([\d.]+) MiB/.exec(res.stdout);
    assert.ok(m, "child did not report peak RSS");
    const input = /input: ([\d.]+) MiB/.exec(res.stdout);
    console.log(`input: ${input?.[1]} MiB, peak RSS: ${m[1]} MiB`);
    assert.ok(
      Number.parseFloat(m[1]) < 160,
      `peak RSS ${m[1]} MiB exceeds 160 MiB`,
    );
  });
} else {
test("100MiB+ generated import: random entities, bidirectional refs, memory", { timeout: 600_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepidx-big-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srcPath = path.join(dir, "big.step");
  const dbPath = path.join(dir, "big.db");

  // Generate >= 100 MiB of STEP data.
  {
    const out = fs.createWriteStream(srcPath);
    const write = async (s: string) => {
      if (!out.write(s)) await new Promise<void>((r) => out.once("drain", () => r()));
    };
    await write("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('big'),'2;1');\nENDSEC;\nDATA;\n");
    for (let i = 1; i <= N; i++) await write(recordFor(i));
    await write("ENDSEC;\nEND-ISO-10303-21;\n");
    await new Promise<void>((r) => out.end(r));
  }
  const size = fs.statSync(srcPath).size;
  assert.ok(size >= 100 * MIB, `generated file too small: ${size}`);

  // Import in 1 MiB chunks, sampling RSS.
  const idx = StepIndex.open(dbPath);
  const imp = idx.beginImport();
  let peakRss = process.memoryUsage().rss;
  {
    const fd = fs.openSync(srcPath, "r");
    const buf = Buffer.allocUnsafe(MIB);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, MIB, pos);
      if (n === 0) break;
      imp.write(buf.subarray(0, n));
      pos += n;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    fs.closeSync(fd);
  }
  imp.finish();
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  // Remove the source: queries must still work from SQLite alone.
  fs.unlinkSync(srcPath);

  assert.equal(idx.entityCount(), N);

  // Deterministic pseudo-random sample of entities.
  let x = 12345;
  for (let k = 0; k < 300; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const i = (x % N) + 1;
    const e = idx.getEntity(i)!;
    assert.ok(e, `entity #${i} missing`);
    assert.equal(e.id, String(i));
    assert.equal(e.complex, false);
    assert.equal(e.components[0].name, `PART${i}`);
    const params = e.components[0].params;
    assert.deepEqual(params[1], { t: "num", raw: `-${i}.25` });
    const strParam = params[0] as { t: "str"; v: string };
    assert.equal(strParam.t, "str");
    assert.ok(strParam.v.includes(`#${pseudoRef(i)}`));
    assert.ok(strParam.v.includes("ENDSEC;"));
    assert.deepEqual(e.forwardRefs, expectedForward(i), `forward refs of #${i}`);
    assert.deepEqual(e.backwardRefs, expectedBackward(i), `backward refs of #${i}`);
  }

  const peakMiB = peakRss / MIB;
  console.log(`input: ${(size / MIB).toFixed(1)} MiB, entities: ${N}, peak RSS: ${peakMiB.toFixed(1)} MiB`);
  assert.ok(
    peakRss < 160 * MIB,
    `peak RSS ${peakMiB.toFixed(1)} MiB exceeds 160 MiB`,
  );
  idx.close();
});
}
