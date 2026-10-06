import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LocalPulse } from '../src/localPulse';
import { ScoringHarness, profile, tick } from './helpers';
import type { ReadyReport } from '../src/types';

// 场景：暂停门店 A 的评分，保持空闲名额，验证门店 B 能独立发布，
// 且两者写入与读取仍可完成；同时记录实际未结束的评分数量，验证并发上限。
test('门店 A 评分暂停不阻塞门店 B，且全局并发不超过 4', async () => {
  const harness = new ScoringHarness();
  const pulse = new LocalPulse({ scoreFn: harness.scoreFn });

  // 门店 A：两个目录，评分全部暂停。
  pulse.putCanonical('A', profile({ businessName: 'A' }));
  pulse.putListing('A', 'dirA1', profile({ businessName: 'A1' }));
  pulse.putListing('A', 'dirA2', profile({ businessName: 'A2' }));
  await tick();
  assert.equal(harness.running, 3, 'A 的评分已启动但未结束');

  // 门店 B：在 A 暂停期间写入并发布。
  pulse.putCanonical('B', profile({ businessName: 'B' }));
  pulse.putListing('B', 'dirB1', profile({ businessName: 'B1' }));
  await tick();
  assert.equal(harness.running, 4, 'B 的评分在空闲名额内启动');
  assert.equal(harness.maxRunning, 4, '并发不超过上限 4');

  // 读写不等评分：暂停期间写入与读取都能完成。
  const revB = pulse.putListing('B', 'dirB2', profile({ businessName: 'B2' }));
  assert.equal(revB, 3);
  const pendingA = pulse.getReport('A');
  assert.deepEqual(
    { status: pendingA.status, revision: pendingA.revision },
    { status: 'pending', revision: 3 },
  );
  await tick();
  assert.equal(harness.running, 4, 'B 的新评分补进空闲名额，并发仍不超上限');

  // 只完成 B 的评分：B 独立发布，A 仍然 pending。
  await harness.resolveAllWhere((s) => s.locationId === 'B');
  const reportB = pulse.getReport('B') as ReadyReport;
  assert.equal(reportB.status, 'ready');
  assert.equal(reportB.revision, 3);
  assert.deepEqual(
    reportB.directories.map((d) => [d.directory, d.score]),
    [
      ['dirB1', 75],
      ['dirB2', 75],
    ],
  );
  assert.equal(pulse.getReport('A').status, 'pending', 'A 的评分仍暂停，保持 pending');

  // B 已发布后，A 的写入与读取仍可完成。
  pulse.putListing('A', 'dirA1', profile({ businessName: 'A1b' }));
  assert.equal(pulse.getReport('A').revision, 4);

  // 放开 A 的全部评分后，A 收敛到最新修订。
  await harness.resolveAll();
  await pulse.whenIdle();
  const reportA = pulse.getReport('A') as ReadyReport;
  assert.equal(reportA.status, 'ready');
  assert.equal(reportA.revision, 4);
  assert.equal(reportA.listings['dirA1']!.businessName, 'A1b');
  assert.ok(harness.maxRunning <= 4, `并发峰值 ${harness.maxRunning} 不超过 4`);
});

test('大量目录时实际未结束评分数量始终不超过 4', async () => {
  const harness = new ScoringHarness();
  const pulse = new LocalPulse({ scoreFn: harness.scoreFn });

  pulse.putCanonical('loc', profile());
  for (let i = 0; i < 10; i += 1) {
    pulse.putListing('loc', `dir${i}`, profile({ businessName: `L${i}` }));
  }
  await tick();
  assert.equal(harness.running, 4, '只有 4 个评分在进行，其余排队');

  // 每完成一个，补位一个，峰值始终为 4。
  for (let i = 0; i < 6; i += 1) {
    await harness.resolveOne();
    assert.ok(harness.running <= 4);
  }
  await harness.resolveAll();
  await pulse.whenIdle();
  assert.equal(harness.maxRunning, 4);
  const report = pulse.getReport('loc') as ReadyReport;
  assert.equal(report.status, 'ready');
  assert.equal(report.directories.length, 10);
});
