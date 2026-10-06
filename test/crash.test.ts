import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { CHUNK_SIZE, UploadStore } from "../src/index";
import { dirUsage, makeFakeFile, makeTempDir, removeDir } from "./helpers";
import { runWorker } from "./runner";
import { test } from "./testkit";

const FILE = makeFakeFile(CHUNK_SIZE * 2 + 321); // 3 段

interface Op {
  op: string;
  sessionId: string;
  totalBytes?: number;
  sha256?: string;
  index?: number;
  dataFile?: string;
}

function buildScript(dir: string, upToComplete: boolean): { script: unknown; ops: Op[] } {
  const ops: Op[] = [
    { op: "begin", sessionId: "s", totalBytes: FILE.totalBytes, sha256: FILE.sha256 },
  ];
  FILE.chunks.forEach((chunk, index) => {
    const dataFile = path.join(dir, `payload-${index}`);
    fs.writeFileSync(dataFile, chunk);
    ops.push({ op: "submit", sessionId: "s", index, dataFile });
  });
  if (upToComplete) {
    ops.push({ op: "complete", sessionId: "s" });
  }
  return { script: { dir, ops, stepDelayMs: 30, holdBeforeExitMs: 300 }, ops };
}

/** 从 worker 输出中提取已 ack 的提交序号与可能处于飞行中的提交序号。 */
function ackedInfo(lines: string[]): { acked: number[]; inFlight: number | null } {
  const acked: number[] = [];
  let inFlight: number | null = null;
  for (const line of lines) {
    const ack = /^ack \d+ submit (\d+)$/.exec(line);
    if (ack !== null) {
      acked.push(Number(ack[1]));
    }
  }
  const pres = lines.filter((l) => /^pre \d+ submit$/.test(l)).length;
  if (pres > acked.length) {
    // 有一个 submit 开始了但没 ack（被杀）；其序号 = 已 ack 数（按脚本顺序）
    inFlight = pres - 1;
  }
  return { acked, inFlight };
}

function assertConsistentProgress(dir: string, acked: number[], inFlight: number | null): void {
  const store = new UploadStore(dir);
  try {
    const p = store.progress("s");
    assert.strictEqual(p.completed, false);
    for (const index of acked) {
      assert.ok(
        p.confirmedChunks.includes(index),
        `已确认分段 ${index} 不得倒退（confirmed=${p.confirmedChunks}）`
      );
    }
    const allowed = new Set(acked);
    if (inFlight !== null) {
      allowed.add(inFlight);
    }
    for (const index of p.confirmedChunks) {
      assert.ok(allowed.has(index), `不得确认未落盘的分段 ${index}`);
    }
    // 磁盘上的分段文件必须与已确认集合一一对应（无半个分段、无未确认残留）
    const chunksRoot = path.join(dir, "chunks");
    const onDisk: string[] = [];
    if (fs.existsSync(chunksRoot)) {
      for (const sessDir of fs.readdirSync(chunksRoot)) {
        for (const f of fs.readdirSync(path.join(chunksRoot, sessDir))) {
          onDisk.push(f);
          const size = fs.statSync(path.join(chunksRoot, sessDir, f)).size;
          const expected = Math.min(
            CHUNK_SIZE,
            FILE.totalBytes - Number(f) * CHUNK_SIZE
          );
          assert.strictEqual(size, expected, `分段 ${f} 不得是半个分段`);
        }
      }
    }
    assert.strictEqual(
      onDisk.length,
      p.confirmedChunks.length,
      "磁盘分段数必须与已确认数一致"
    );
    // 临时目录不得有半成品残留
    assert.strictEqual(dirUsage(path.join(dir, "tmp")).files, 0);
  } finally {
    store.close();
  }
}

function finishAndVerify(dir: string): void {
  const store = new UploadStore(dir);
  try {
    // 客户端只需重传未确认的分段
    const p = store.progress("s");
    for (let i = 0; i < FILE.chunks.length; i += 1) {
      if (!p.confirmedChunks.includes(i)) {
        store.submitChunk("s", i, FILE.chunks[i] as Buffer);
      }
    }
    const ref = store.complete("s");
    assert.ok(fs.readFileSync(ref.path).equals(FILE.whole), "读回字节必须与原始输入一致");
  } finally {
    store.close();
  }
}

const KILL_POINTS = [
  { name: "首个分段写入前", trigger: "pre 1", delayMs: 0 },
  { name: "分段提交返回后立刻", trigger: "ack 2", delayMs: 0 },
  { name: "分段提交返回瞬间", trigger: "ack 2", delayMs: 5 },
  { name: "5MiB 分段写入进行中", trigger: "pre 3", delayMs: 0 },
  { name: "最后一个分段返回后", trigger: "ack 3", delayMs: 30 },
];

for (const point of KILL_POINTS) {
  test(`分段提交被杀（${point.name}）后恢复，进度不倒退`, async () => {
    const dir = makeTempDir();
    try {
      const { script } = buildScript(dir, false);
      const result = await runWorker(script, {
        trigger: point.trigger,
        delayMs: point.delayMs,
      });
      assert.strictEqual(result.signal, "SIGKILL", `worker 应被强杀: ${result.stderr}`);
      const { acked, inFlight } = ackedInfo(result.lines);
      // 重新打开即恢复；可反复打开（恢复幂等、可再次中断）
      assertConsistentProgress(dir, acked, inFlight);
      assertConsistentProgress(dir, acked, inFlight);
      finishAndVerify(dir);
    } finally {
      removeDir(dir);
    }
  });
}

test("完成上传被杀（拼接进行中）后恢复并重试完成", async () => {
  const dir = makeTempDir();
  try {
    const { script } = buildScript(dir, true);
    const result = await runWorker(script, { trigger: "pre 4", delayMs: 40 });
    assert.strictEqual(result.signal, "SIGKILL", `worker 应被强杀: ${result.stderr}`);

    const store = new UploadStore(dir);
    try {
      const p = store.progress("s");
      if (p.completed) {
        // 完成已提交：引用必须指向存在的文件且内容正确
        assert.ok(p.filePath !== undefined);
        assert.ok(fs.existsSync(p.filePath as string));
        assert.ok(fs.readFileSync(p.filePath as string).equals(FILE.whole));
      } else {
        // 完成未提交：全部分段必须仍在，可重试完成
        assert.deepStrictEqual(p.confirmedChunks, [0, 1, 2]);
      }
      const ref = store.complete("s");
      assert.ok(fs.readFileSync(ref.path).equals(FILE.whole));
      // 恢复后磁盘占用：分段副本、半成品清除，只剩一份完整文件
      assert.strictEqual(dirUsage(path.join(dir, "chunks")).files, 0);
      assert.strictEqual(dirUsage(path.join(dir, "tmp")).files, 0);
      const filesUsage = dirUsage(path.join(dir, "files"));
      assert.strictEqual(filesUsage.files, 1);
      assert.strictEqual(filesUsage.bytes, FILE.totalBytes);
    } finally {
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});

test("完成返回后被杀，跨重启重复完成返回同一引用", async () => {
  const dir = makeTempDir();
  try {
    const { script } = buildScript(dir, true);
    const result = await runWorker(script, { trigger: "ack 4", delayMs: 0 });
    assert.strictEqual(result.signal, "SIGKILL", `worker 应被强杀: ${result.stderr}`);
    const completedLine = result.lines.find((l) => /^ack 4 complete /.test(l));
    assert.ok(completedLine !== undefined, "complete 应已返回");
    const firstPath = completedLine.replace(/^ack 4 complete /, "");

    // 跨重启：重新打开，重复 begin（不重置）+ 重复 complete（同一引用）
    const store = new UploadStore(dir);
    try {
      store.begin("s", FILE.totalBytes, FILE.sha256);
      const p = store.progress("s");
      assert.strictEqual(p.completed, true);
      assert.strictEqual(p.filePath, firstPath);
      const ref = store.complete("s");
      assert.strictEqual(ref.path, firstPath, "重复完成必须返回同一引用");
      assert.ok(fs.readFileSync(ref.path).equals(FILE.whole));
      // 恢复清理：分段副本与半成品已清除
      assert.strictEqual(dirUsage(path.join(dir, "chunks")).files, 0);
      assert.strictEqual(dirUsage(path.join(dir, "tmp")).files, 0);
      assert.strictEqual(dirUsage(path.join(dir, "files")).files, 1);
    } finally {
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});

test("恢复过程本身被再次中断，仍可恢复到一致状态", async () => {
  const dir = makeTempDir();
  try {
    // 先制造一个需要恢复的现场：提交两段后被杀
    const { script } = buildScript(dir, false);
    const first = await runWorker(script, { trigger: "ack 2", delayMs: 0 });
    assert.strictEqual(first.signal, "SIGKILL");

    // 再次打开（触发恢复），在恢复进行中（ready 之前）随机时刻强杀
    const script2 = { dir, ops: [{ op: "progress", sessionId: "s" }], stepDelayMs: 5, holdBeforeExitMs: 300 };
    const second = await runWorker(script2, { trigger: "TIMER", delayMs: 10 });
    assert.strictEqual(second.signal, "SIGKILL");

    // 第三次打开：恢复必须完成到一致状态
    const { acked, inFlight } = ackedInfo(first.lines);
    assertConsistentProgress(dir, acked, inFlight);
    finishAndVerify(dir);
  } finally {
    removeDir(dir);
  }
});

test("完成在改名完整文件后、写库前被杀：无主完整文件被清除且可重新完成", async () => {
  const dir = makeTempDir();
  try {
    const { script } = buildScript(dir, true);
    // 在 complete 开始后极短延迟强杀，尽量落在 改名/写库 之间；无论落在哪都必须一致
    const result = await runWorker(script, { trigger: "pre 4", delayMs: 15 });
    assert.strictEqual(result.signal, "SIGKILL");

    const store = new UploadStore(dir);
    try {
      const p = store.progress("s");
      const ref = store.complete("s");
      assert.ok(fs.readFileSync(ref.path).equals(FILE.whole));
      if (p.completed) {
        assert.strictEqual(p.filePath, ref.path);
      }
      // 无论崩溃点在何处：最终只有一份完整文件，无无主文件、无半成品
      assert.strictEqual(dirUsage(path.join(dir, "files")).files, 1);
      assert.strictEqual(dirUsage(path.join(dir, "tmp")).files, 0);
      assert.strictEqual(dirUsage(path.join(dir, "chunks")).files, 0);
    } finally {
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});
