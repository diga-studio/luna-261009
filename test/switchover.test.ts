import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { ExecutorClient } from '../src/executor-client';
import { Orchestrator } from '../src/orchestrator';
import type { SwitchResult } from '../src/types';
import {
  addPauseRule,
  addRejectRule,
  applied,
  assertAppliedBefore,
  assertAppliedOnce,
  cleanupEnv,
  killRunnerAndExecutor,
  makeEnv,
  readHistory,
  readStates,
  spawnRunner,
  waitForFile,
} from './helpers';

const VMS = ['vm1', 'vm2', 'vm3'];

async function createGroup(env: ReturnType<typeof makeEnv>): Promise<void> {
  const executor = new ExecutorClient(env.execDb);
  await executor.start();
  const orchestrator = new Orchestrator(env.orchDb, executor);
  await orchestrator.createGroup('g1', VMS);
  orchestrator.close();
  await executor.stop();
}

async function recoverInProcess(
  env: ReturnType<typeof makeEnv>,
): Promise<SwitchResult[]> {
  const executor = new ExecutorClient(env.execDb);
  await executor.start();
  const orchestrator = new Orchestrator(env.orchDb, executor);
  try {
    return await orchestrator.recover();
  } finally {
    orchestrator.close();
    await executor.stop();
  }
}

function assertAllVms(
  states: Record<string, Record<'A' | 'B', string>>,
  aState: string,
  bState: string,
): void {
  for (const vm of VMS) {
    assert.equal(states[vm]?.A, aState, `${vm} site A`);
    assert.equal(states[vm]?.B, bState, `${vm} site B`);
  }
}

test('kill after only part of the source side stopped, then recover', async (t) => {
  const env = makeEnv('partial-source-stop');
  t.after(() => cleanupEnv(env));
  await createGroup(env);

  // Executor pauses right before applying vm2's stop on site A: vm1 is already
  // stopped, vm2/vm3 still running when we kill both processes.
  addPauseRule(env.execDb, 'beforeApply', { vmId: 'vm2', site: 'A', op: 'stop' });

  const runner = spawnRunner(['switch', env.orchDb, env.execDb, 'g1', 'req-1']);
  await waitForFile(env.pauseFlag);
  await killRunnerAndExecutor(runner);

  // Mid-failure state: only vm1 stopped on A, nothing touched on B.
  const midStates = readStates(env.execDb);
  assert.equal(midStates.vm1.A, 'stopped');
  assert.equal(midStates.vm2.A, 'running');
  assert.equal(midStates.vm3.A, 'running');
  for (const vm of VMS) assert.equal(midStates[vm].B, 'stopped', `${vm} site B`);
  const midHistory = readHistory(env.execDb);
  const vm1Stop = midHistory.filter(
    (e) => e.vmId === 'vm1' && e.site === 'A' && e.op === 'stop',
  );
  assert.deepEqual(vm1Stop.map((e) => e.event), ['received', 'applied']);
  // vm2's stop was received by the executor but never applied.
  const vm2Stop = midHistory.filter(
    (e) => e.vmId === 'vm2' && e.site === 'A' && e.op === 'stop',
  );
  assert.deepEqual(vm2Stop.map((e) => e.event), ['received']);

  // Recover in a fresh process (no memory of the killed one).
  fs.rmSync(env.pauseFlag, { force: true });
  const results = await recoverInProcess(env);
  assert.equal(results.length, 1);
  assert.equal(results[0].requestId, 'req-1');
  assert.equal(results[0].status, 'success');
  assert.equal(results[0].activeSite, 'B');

  // Final state: whole group on B, nothing running on A.
  assertAllVms(readStates(env.execDb), 'stopped', 'running');

  // Full execution history: every instruction applied exactly once, and the
  // entire source side stopped before any target replica started.
  const history = readHistory(env.execDb);
  assertAppliedOnce(history);
  assertAppliedBefore(
    history,
    (e) => e.site === 'A' && e.op === 'stop',
    (e) => e.site === 'B' && e.op === 'start',
    'all source stops precede any target start',
  );
  for (const vm of VMS) {
    const stops = applied(history).filter(
      (e) => e.vmId === vm && e.site === 'A' && e.op === 'stop',
    );
    assert.equal(stops.length, 1, `${vm} stopped exactly once`);
  }

  // Orchestrator view agrees, and nothing is left hanging.
  const executor = new ExecutorClient(env.execDb);
  await executor.start();
  const orchestrator = new Orchestrator(env.orchDb, executor);
  const inspection = await orchestrator.inspect('g1');
  assert.equal(inspection.activeSite, 'B');
  assert.equal(inspection.request?.requestId, 'req-1');
  assert.equal(inspection.request?.status, 'success');
  for (const vm of inspection.vms) {
    assert.equal(vm.A, 'stopped');
    assert.equal(vm.B, 'running');
  }
  assert.deepEqual(await orchestrator.recover(), []);
  orchestrator.close();
  await executor.stop();
});

test('switch A->B then B->A, replaying the first request is a no-op', async (t) => {
  const env = makeEnv('replay');
  t.after(() => cleanupEnv(env));

  const executor = new ExecutorClient(env.execDb);
  await executor.start();
  const orchestrator = new Orchestrator(env.orchDb, executor);
  t.after(() => {
    orchestrator.close();
  });
  await orchestrator.createGroup('g1', VMS);

  const first = await orchestrator.switchGroup('g1', 'req-1');
  assert.equal(first.status, 'success');
  assert.equal(first.activeSite, 'B');
  let inspection = await orchestrator.inspect('g1');
  assert.equal(inspection.activeSite, 'B');
  for (const vm of inspection.vms) {
    assert.equal(vm.A, 'stopped');
    assert.equal(vm.B, 'running');
  }

  const second = await orchestrator.switchGroup('g1', 'req-2');
  assert.equal(second.status, 'success');
  assert.equal(second.activeSite, 'A');
  inspection = await orchestrator.inspect('g1');
  assert.equal(inspection.activeSite, 'A');
  assert.equal(inspection.request?.requestId, 'req-2');
  assert.equal(inspection.request?.status, 'success');
  for (const vm of inspection.vms) {
    assert.equal(vm.A, 'running');
    assert.equal(vm.B, 'stopped');
  }

  // Replaying the original request id must return its recorded terminal
  // result without switching anything again.
  const historyBefore = readHistory(env.execDb);
  const replay = await orchestrator.switchGroup('g1', 'req-1');
  assert.equal(replay.status, 'success');
  assert.equal(replay.activeSite, 'A', 'replay must not change the active site');
  const replay2 = await orchestrator.switchGroup('g1', 'req-2');
  assert.equal(replay2.status, 'success');
  assert.equal(replay2.activeSite, 'A');

  const historyAfter = readHistory(env.execDb);
  assert.deepEqual(historyAfter, historyBefore, 'replay issued no VM instructions');

  inspection = await orchestrator.inspect('g1');
  assert.equal(inspection.activeSite, 'A');
  for (const vm of inspection.vms) {
    assert.equal(vm.A, 'running');
    assert.equal(vm.B, 'stopped');
  }

  // Full history of both switches: per request, every source stop precedes
  // every target start, and no instruction was ever applied twice.
  assertAppliedOnce(historyAfter);
  const req1 = historyAfter.filter((e) => e.instructionId.startsWith('g1/req-1/'));
  assertAppliedBefore(
    req1,
    (e) => e.site === 'A' && e.op === 'stop',
    (e) => e.site === 'B' && e.op === 'start',
    'req-1: all A stops precede any B start',
  );
  const req2 = historyAfter.filter((e) => e.instructionId.startsWith('g1/req-2/'));
  assertAppliedBefore(
    req2,
    (e) => e.site === 'B' && e.op === 'stop',
    (e) => e.site === 'A' && e.op === 'start',
    'req-2: all B stops precede any A start',
  );
  // Every VM took part in both switches on both sites.
  for (const vm of VMS) {
    for (const [req, site, op] of [
      ['req-1', 'A', 'stop'],
      ['req-1', 'B', 'start'],
      ['req-2', 'B', 'stop'],
      ['req-2', 'A', 'start'],
    ] as const) {
      assert.ok(
        applied(historyAfter).some(
          (e) =>
            e.instructionId === `g1/${req}/${op === 'stop' ? 'stopping_source' : 'starting_target'}/${vm}` &&
            e.site === site &&
            e.op === op,
        ),
        `${vm} ${op} on ${site} applied in ${req}`,
      );
    }
  }

  await executor.stop();
});

test('lost reply after partial target start, permanent reject, kill mid-rollback', async (t) => {
  const env = makeEnv('rollback');
  t.after(() => cleanupEnv(env));
  await createGroup(env);

  // Phase 1: executor persists vm2's start on B but is killed before the
  // reply reaches the orchestrator; vm3 was never started.
  addPauseRule(env.execDb, 'afterPersist', { vmId: 'vm2', site: 'B', op: 'start' });
  const first = spawnRunner(['switch', env.orchDb, env.execDb, 'g1', 'req-1']);
  await waitForFile(env.pauseFlag);
  await killRunnerAndExecutor(first);

  const afterLost = readStates(env.execDb);
  for (const vm of VMS) assert.equal(afterLost[vm].A, 'stopped', `${vm} site A`);
  assert.equal(afterLost.vm1.B, 'running');
  assert.equal(afterLost.vm2.B, 'running');
  assert.equal(afterLost.vm3.B, 'stopped');

  // Phase 2: vm3's start on B will be permanently rejected; the executor is
  // killed again in the middle of the rollback (before vm2's stop on B).
  fs.rmSync(env.pauseFlag, { force: true });
  addRejectRule(env.execDb, 'vm3', 'B');
  addPauseRule(env.execDb, 'beforeApply', { vmId: 'vm2', site: 'B', op: 'stop' });
  const second = spawnRunner(['recover', env.orchDb, env.execDb]);
  await waitForFile(env.pauseFlag);
  await killRunnerAndExecutor(second);

  const midRollback = readStates(env.execDb);
  assert.equal(midRollback.vm1.B, 'stopped', 'vm1 already rolled back');
  assert.equal(midRollback.vm2.B, 'running', 'vm2 rollback stop not applied yet');
  assert.equal(midRollback.vm3.B, 'stopped');
  for (const vm of VMS) assert.equal(midRollback[vm].A, 'stopped', `${vm} site A`);
  const historySoFar = readHistory(env.execDb);
  assert.ok(
    historySoFar.some(
      (e) => e.instructionId === 'g1/req-1/starting_target/vm2' && e.event === 'replayed',
    ),
    'vm2 target start replayed without re-applying',
  );
  assert.ok(
    historySoFar.some(
      (e) => e.instructionId === 'g1/req-1/starting_target/vm3' && e.event === 'rejected',
    ),
    'vm3 target start permanently rejected',
  );
  assert.ok(
    !applied(historySoFar).some(
      (e) => e.instructionId === 'g1/req-1/starting_target/vm3',
    ),
    'rejected start had no side effect',
  );

  // Phase 3: recover again; the rollback must run to completion.
  fs.rmSync(env.pauseFlag, { force: true });
  const results = await recoverInProcess(env);
  assert.equal(results.length, 1);
  assert.equal(results[0].requestId, 'req-1');
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].activeSite, 'A');
  assert.match(results[0].reason ?? '', /vm3/);

  // Final state: failure left the active site untouched; the whole group is
  // back on A with every B replica stopped.
  const finalStates = readStates(env.execDb);
  assertAllVms(
    Object.fromEntries(VMS.map((vm) => [vm, { A: finalStates[vm].A, B: finalStates[vm].B }])),
    'running',
    'stopped',
  );

  const executor = new ExecutorClient(env.execDb);
  await executor.start();
  const orchestrator = new Orchestrator(env.orchDb, executor);
  const inspection = await orchestrator.inspect('g1');
  assert.equal(inspection.activeSite, 'A');
  assert.equal(inspection.request?.requestId, 'req-1');
  assert.equal(inspection.request?.status, 'failed');
  for (const vm of inspection.vms) {
    assert.equal(vm.A, 'running');
    assert.equal(vm.B, 'stopped');
  }
  // Nothing left to recover.
  assert.deepEqual(await orchestrator.recover(), []);
  orchestrator.close();
  await executor.stop();

  // Full execution history: every instruction applied at most once, all
  // source stops before any target start, and all rollback stops on B before
  // any restart on A.
  const history = readHistory(env.execDb);
  assertAppliedOnce(history);
  assertAppliedBefore(
    history,
    (e) => e.site === 'A' && e.op === 'stop',
    (e) => e.site === 'B' && e.op === 'start',
    'all A stops precede any B start',
  );
  assertAppliedBefore(
    history,
    (e) => e.site === 'B' && e.op === 'stop',
    (e) => e.site === 'A' && e.op === 'start',
    'all rollback B stops precede any A restart',
  );
  // No VM was ever running on both sites at the same time: for every VM the
  // A stop was applied before its B start, and the B stop before its A
  // restart. (vm3's B start was rejected, so it has no B-start application.)
  for (const vm of VMS) {
    const startedOnB = applied(history).some(
      (e) => e.vmId === vm && e.site === 'B' && e.op === 'start',
    );
    if (startedOnB) {
      assertAppliedBefore(
        history,
        (e) => e.vmId === vm && e.site === 'A' && e.op === 'stop',
        (e) => e.vmId === vm && e.site === 'B' && e.op === 'start',
        `${vm}: A stop precedes B start`,
      );
    }
    assertAppliedBefore(
      history,
      (e) => e.vmId === vm && e.site === 'B' && e.op === 'stop',
      (e) => e.vmId === vm && e.site === 'A' && e.op === 'start',
      `${vm}: B stop precedes A restart`,
    );
  }
});
