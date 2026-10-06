import { test } from "node:test";
import assert from "node:assert/strict";
import {
  armPause,
  armReject,
  cmdId,
  readHistory,
  readReplicas,
  runRecoverWorker,
  runSwitchWorker,
  setupEnv,
  waitPauseHit,
} from "./helpers.js";

const VMS = ["vm1", "vm2", "vm3", "vm4"];

test("源端只停了一部分时终止，恢复后切换成功", async (t) => {
  const env = await setupEnv();
  t.after(env.cleanup);
  await env.orchestrator.createGroup("g1", VMS);
  await env.executor.shutdown();

  // 第 3 台（vm3，seq=2）的源端停止指令生效前暂停执行器。
  const pauseCmd = cmdId("g1", "r1", 2);
  armPause(env.execDb, pauseCmd, "beforeApply");
  const worker = runSwitchWorker(env.orchDb, env.execDb, "g1", "r1");
  await waitPauseHit(env.execDb, pauseCmd, "beforeApply");
  worker.kill();
  await assert.rejects(worker.done);

  // 撤去故障：重启执行器并 Recover。
  await env.executor.start();
  await env.orchestrator.recover();

  // 最终状态：B 全部运行、A 全部停止、活动站点 B、请求成功。
  const insp = await env.orchestrator.inspect("g1");
  assert.equal(insp.activeSite, "B");
  assert.equal(insp.request?.requestId, "r1");
  assert.equal(insp.request?.outcome, "success");
  assert.equal(insp.request?.phase, "DONE");
  for (const m of insp.members) {
    assert.equal(m.a, "stopped", `${m.vmId} A 端应停止`);
    assert.equal(m.b, "running", `${m.vmId} B 端应运行`);
  }
  // 直接读执行器库核验副本实际状态。
  for (const r of readReplicas(env.execDb)) {
    assert.equal(r.state, r.site === "B" ? "running" : "stopped", `${r.vmId}@${r.site}`);
  }

  // 完整执行历史核验。
  const history = readHistory(env.execDb);
  const applied = history.filter((h) => h.applied === 1);
  // 恰好 8 条生效：4 停 A + 4 启 B，回滚指令不执行。
  assert.equal(applied.length, 8);
  assert.equal(applied.filter((h) => h.op === "stop" && h.site === "A").length, 4);
  assert.equal(applied.filter((h) => h.op === "start" && h.site === "B").length, 4);
  // 每条指令只生效一次（被中断的 vm3 停止没有重复生效）。
  const appliedIds = applied.map((h) => h.commandId);
  assert.equal(new Set(appliedIds).size, appliedIds.length);
  // 整个源端停止先于任何目标端启动。
  const lastStopA = Math.max(...applied.filter((h) => h.op === "stop").map((h) => h.seq));
  const firstStartB = Math.min(...applied.filter((h) => h.op === "start").map((h) => h.seq));
  assert.ok(lastStopA < firstStartB, "所有 A 端停止必须先于任何 B 端启动");
});

test("目标端部分启动且回复丢失时终止，恢复后另一台启动被永久拒绝，回滚途中再终止并恢复", async (t) => {
  const env = await setupEnv();
  t.after(env.cleanup);
  await env.orchestrator.createGroup("g1", VMS);
  await env.executor.shutdown();

  // seq: 0-3 停A, 4-7 启B, 8-11 停B(回滚), 12-15 启A(回滚)
  const lostReplyCmd = cmdId("g1", "r1", 5); // 启 B vm2：生效并持久化后、回复前暂停
  armPause(env.execDb, lostReplyCmd, "beforeReply");
  const worker1 = runSwitchWorker(env.orchDb, env.execDb, "g1", "r1");
  await waitPauseHit(env.execDb, lostReplyCmd, "beforeReply");
  worker1.kill();
  await assert.rejects(worker1.done);

  // 恢复前注入新故障：启 B vm3（seq 6）永久拒绝；回滚停 B vm2（seq 9）生效前暂停。
  await env.executor.start();
  await env.executor.shutdown();
  armReject(env.execDb, cmdId("g1", "r1", 6));
  const rollbackPauseCmd = cmdId("g1", "r1", 9);
  armPause(env.execDb, rollbackPauseCmd, "beforeApply");
  const worker2 = runRecoverWorker(env.orchDb, env.execDb);
  await waitPauseHit(env.execDb, rollbackPauseCmd, "beforeApply");
  worker2.kill();
  await assert.rejects(worker2.done);

  // 撤去全部故障，再次 Recover 至收敛。
  await env.executor.start();
  await env.orchestrator.recover();

  // 最终状态：回滚完成，A 全部运行、B 全部停止、活动站点仍为 A、请求失败。
  const insp = await env.orchestrator.inspect("g1");
  assert.equal(insp.activeSite, "A");
  assert.equal(insp.request?.outcome, "failure");
  assert.equal(insp.request?.phase, "DONE");
  for (const m of insp.members) {
    assert.equal(m.a, "running", `${m.vmId} A 端应运行`);
    assert.equal(m.b, "stopped", `${m.vmId} B 端应停止`);
  }
  for (const r of readReplicas(env.execDb)) {
    assert.equal(r.state, r.site === "A" ? "running" : "stopped", `${r.vmId}@${r.site}`);
  }

  const history = readHistory(env.execDb);
  const applied = history.filter((h) => h.applied === 1);
  // 任何指令不得重复生效。
  const appliedIds = applied.map((h) => h.commandId);
  assert.equal(new Set(appliedIds).size, appliedIds.length, "指令不得重复生效");
  // 回复丢失的指令（seq 5）只生效一次，且留有重放痕迹（applied=0 返回原结果）。
  const lostRows = history.filter((h) => h.commandId === lostReplyCmd);
  assert.equal(lostRows.filter((h) => h.applied === 1).length, 1);
  assert.ok(
    lostRows.some((h) => h.applied === 0 && h.outcome === "ok"),
    "丢失回复的指令重放应返回原结果且不再次生效",
  );
  // 被拒绝的启动（seq 6）：永久拒绝、无副作用。
  const rejectedRows = history.filter((h) => h.commandId === cmdId("g1", "r1", 6));
  assert.equal(rejectedRows.length, 1);
  assert.equal(rejectedRows[0]!.outcome, "rejected");
  assert.equal(rejectedRows[0]!.applied, 0);
  // B 端只有 vm1、vm2 启动过；vm3、vm4 的 B 端从未运行。
  const startedB = new Set(
    applied.filter((h) => h.site === "B" && h.op === "start").map((h) => h.vmId),
  );
  assert.deepEqual([...startedB].sort(), ["vm1", "vm2"]);
  // 生效顺序：全部停 A < 任何启 B < 任何停 B < 任何启 A。
  const order = (pred: (h: (typeof applied)[number]) => boolean) =>
    applied.filter(pred).map((h) => h.seq);
  const maxOf = (xs: number[]) => Math.max(...xs);
  const minOf = (xs: number[]) => Math.min(...xs);
  const stopA = order((h) => h.site === "A" && h.op === "stop");
  const startB = order((h) => h.site === "B" && h.op === "start");
  const stopB = order((h) => h.site === "B" && h.op === "stop");
  const startA = order((h) => h.site === "A" && h.op === "start");
  assert.equal(stopA.length, 4);
  assert.equal(stopB.length, 4, "回滚停止全部 B 端副本");
  assert.equal(startA.length, 4);
  assert.ok(maxOf(stopA) < minOf(startB), "全部停 A 先于任何启 B");
  assert.ok(maxOf(startB) < minOf(stopB), "全部启 B 先于任何停 B");
  assert.ok(maxOf(stopB) < minOf(startA), "全部停 B 先于任何启 A（回滚顺序）");
});

test("A到B成功后再B到A成功，重放最初请求不得再次切换", async (t) => {
  const env = await setupEnv();
  t.after(env.cleanup);
  await env.orchestrator.createGroup("g1", VMS);
  await env.executor.shutdown();

  // A -> B 成功。
  const w1 = runSwitchWorker(env.orchDb, env.execDb, "g1", "r1");
  await w1.done;
  // B -> A 成功（故障回切，规则相同）。
  const w2 = runSwitchWorker(env.orchDb, env.execDb, "g1", "r2");
  await w2.done;

  await env.executor.start();
  const insp1 = await env.orchestrator.inspect("g1");
  assert.equal(insp1.activeSite, "A");
  assert.equal(insp1.request?.requestId, "r2");
  assert.equal(insp1.request?.outcome, "success");

  // 重放最初的 r1：返回原有终态，不得再次切换、不得发出新指令。
  const historyBefore = readHistory(env.execDb);
  const replay = await env.orchestrator.switchGroup("g1", "r1");
  assert.equal(replay.outcome, "success");
  assert.equal(replay.activeSite, "A", "重放旧请求不得改变当前活动站点");
  const historyAfter = readHistory(env.execDb);
  assert.deepEqual(historyAfter, historyBefore, "重放不得产生任何新的执行历史");

  // 全部副本状态：A 全部运行、B 全部停止。
  const insp2 = await env.orchestrator.inspect("g1");
  assert.equal(insp2.activeSite, "A");
  for (const m of insp2.members) {
    assert.equal(m.a, "running", `${m.vmId} A 端应运行`);
    assert.equal(m.b, "stopped", `${m.vmId} B 端应停止`);
  }
  for (const r of readReplicas(env.execDb)) {
    assert.equal(r.state, r.site === "A" ? "running" : "stopped", `${r.vmId}@${r.site}`);
  }

  // 完整执行历史核验：两轮切换各 8 条生效，指令均只生效一次。
  const applied = historyAfter.filter((h) => h.applied === 1);
  assert.equal(applied.length, 16);
  const appliedIds = applied.map((h) => h.commandId);
  assert.equal(new Set(appliedIds).size, appliedIds.length);
  // r1：停 A 后启 B；r2：停 B 后启 A；两轮各自组内有序。
  const round = (req: string, site: string, op: string) =>
    applied
      .filter((h) => h.commandId.startsWith(`g1:${req}:`) && h.site === site && h.op === op)
      .map((h) => h.seq);
  assert.ok(Math.max(...round("r1", "A", "stop")) < Math.min(...round("r1", "B", "start")));
  assert.ok(Math.max(...round("r2", "B", "stop")) < Math.min(...round("r2", "A", "start")));
  // r1 的全部生效先于 r2 的任何生效。
  const r1Seqs = applied.filter((h) => h.commandId.startsWith("g1:r1:")).map((h) => h.seq);
  const r2Seqs = applied.filter((h) => h.commandId.startsWith("g1:r2:")).map((h) => h.seq);
  assert.ok(Math.max(...r1Seqs) < Math.min(...r2Seqs));
});

test("初始状态、参数校验与同组单未完成请求约束", async (t) => {
  const env = await setupEnv();
  t.after(env.cleanup);

  // 组规模 1..50 且成员唯一。
  await assert.rejects(() => env.orchestrator.createGroup("bad0", []));
  await assert.rejects(() =>
    env.orchestrator.createGroup("bad51", Array.from({ length: 51 }, (_, i) => `vm${i}`)),
  );
  await assert.rejects(() => env.orchestrator.createGroup("badDup", ["vm1", "vm1"]));

  await env.orchestrator.createGroup("g1", VMS);
  // 初始状态：活动站点 A，A 端全部运行、B 端全部停止，无请求。
  const insp0 = await env.orchestrator.inspect("g1");
  assert.equal(insp0.activeSite, "A");
  assert.equal(insp0.request, null);
  for (const m of insp0.members) {
    assert.equal(m.a, "running");
    assert.equal(m.b, "stopped");
  }

  // 让第一条停止指令卡在生效前，制造未完成请求。
  armPause(env.execDb, cmdId("g1", "r1", 0), "beforeApply");
  const switching = env.orchestrator.switchGroup("g1", "r1");
  await waitPauseHit(env.execDb, cmdId("g1", "r1", 0), "beforeApply");
  // 同组存在未完成请求时，新 requestId 必须被拒绝。
  await assert.rejects(() => env.orchestrator.switchGroup("g1", "r9"), /unfinished/);
  // 解除暂停，原请求收敛为成功。
  await env.executor.resume();
  const result = await switching;
  assert.equal(result.outcome, "success");
  assert.equal(result.activeSite, "B");
  // 单 VM 组边界。
  await env.orchestrator.createGroup("g2", ["solo"]);
  const r2 = await env.orchestrator.switchGroup("g2", "r1");
  assert.equal(r2.outcome, "success");
  const insp2 = await env.orchestrator.inspect("g2");
  assert.equal(insp2.activeSite, "B");
  assert.deepEqual(
    insp2.members.map((m) => [m.a, m.b]),
    [["stopped", "running"]],
  );
});
