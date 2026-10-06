import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LocalPulse } from '../src/localPulse';
import { ScoringHarness, profile, tick } from './helpers';
import type { ReadyReport } from '../src/types';

// 场景：评分暂停期间连续覆盖同店 10000 次，恢复后只补算最新状态，
// 不逐一重算未启动的历史修订；同时验证调用方修改传入/返回对象不影响内部状态。
test('10000 次连续覆盖只补算最新修订，且对象被调用方修改不影响内部状态', async () => {
  const harness = new ScoringHarness();
  const pulse = new LocalPulse({ scoreFn: harness.scoreFn });

  pulse.putCanonical('loc', profile({ businessName: 'C0' }));
  pulse.putListing('loc', 'dirA', profile({ businessName: 'L0' }));
  await tick();
  const startedBeforeStorm = harness.started.length;
  assert.equal(startedBeforeStorm, 1, 'rev2 的评分已启动并挂起');

  // 评分暂停期间连续覆盖 10000 次；写入与读取都不等待评分。
  const inputs: Array<ReturnType<typeof profile>> = [];
  for (let i = 1; i <= 10000; i += 1) {
    const p = profile({ businessName: `L${i}` });
    inputs.push(p);
    const rev = pulse.putListing('loc', 'dirA', p);
    assert.equal(rev, i + 2);
  }
  assert.equal(pulse.getReport('loc').revision, 10002);
  assert.equal(pulse.getReport('loc').status, 'pending');

  // 调用方修改传入对象不得影响内部状态与正在计算的快照。
  for (const p of inputs) {
    p.businessName = 'MUTATED';
    p.hours[0] = 'MUTATED';
  }

  await tick();
  const startedDuringStorm = harness.started.length - startedBeforeStorm;
  assert.ok(
    startedDuringStorm <= 3,
    `暂停期间最多再占满剩余 3 个并发名额，实际新增 ${startedDuringStorm}`,
  );

  // 解除暂停：只补算最新修订，不逐一重算历史修订。
  await harness.resolveAll();
  await pulse.whenIdle();

  const total = harness.started.length;
  assert.ok(
    total <= 5,
    `10000 次覆盖不得逐一重算：已启动评分总数 ${total} 应 <= 5（4 个占用名额 + 最新修订补算）`,
  );
  const latestRevisionScorings = harness.started.filter((s) => s.revision === 10002);
  assert.equal(latestRevisionScorings.length, 1, '最新修订补算一次');
  const historicalStarted = harness.started.filter((s) => s.revision > 2 && s.revision < 10002);
  assert.ok(
    historicalStarted.length <= 3,
    `被覆盖的历史修订最多只有风暴期间占满空闲名额的 3 个被启动，实际 ${historicalStarted.length}`,
  );

  // 最新报告正确：内部状态未受调用方修改传入对象的影响。
  const report = pulse.getReport('loc') as ReadyReport;
  assert.equal(report.status, 'ready');
  assert.equal(report.revision, 10002);
  assert.equal(report.listings['dirA']!.businessName, 'L10000');
  assert.equal(report.directories[0]!.score, 75);
  assert.deepEqual(report.directories[0]!.diffs, [
    { field: 'businessName', canonicalValue: 'C0', listingValue: 'L10000' },
  ]);

  // 调用方修改返回的报告不得改变组件内部状态。
  report.canonical.businessName = 'HACKED';
  report.listings['dirA']!.businessName = 'HACKED';
  report.listings['dirA']!.hours[0] = 'HACKED';
  report.directories[0]!.score = 0;
  report.directories[0]!.diffs.length = 0;
  (report.directories[0] as { directory: string }).directory = 'HACKED';

  const again = pulse.getReport('loc') as ReadyReport;
  assert.equal(again.canonical.businessName, 'C0');
  assert.equal(again.listings['dirA']!.businessName, 'L10000');
  assert.equal(again.directories[0]!.directory, 'dirA');
  assert.equal(again.directories[0]!.score, 75);
  assert.equal(again.directories[0]!.diffs.length, 1);

  // 传入的 canonical 对象被修改也不影响内部状态。
  const canonical = profile({ businessName: 'C-final' });
  pulse.putCanonical('loc', canonical);
  canonical.businessName = 'MUTATED';
  canonical.hours[3] = 'MUTATED';
  await tick();
  await harness.resolveAll();
  await pulse.whenIdle();
  const final = pulse.getReport('loc') as ReadyReport;
  assert.equal(final.canonical.businessName, 'C-final');
  assert.equal(final.canonical.hours[3], '9-17');
});
