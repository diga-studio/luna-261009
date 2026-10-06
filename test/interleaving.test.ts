import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LocalPulse } from '../src/localPulse';
import { ScoringHarness, profile, tick } from './helpers';
import type { ReadyReport } from '../src/types';

// 场景：同店两个目录，一个评分已完成、另一个暂停；此时修改 canonical 和一个
// listing，再让新旧评分交错完成。任何时刻都不得出现部分报告、混合资料或旧结果覆盖。
test('交错完成的新旧评分不会拼接出混合报告', async () => {
  const harness = new ScoringHarness();
  const pulse = new LocalPulse({ scoreFn: harness.scoreFn });

  const c1 = profile({ businessName: 'C1' });
  const c2 = profile({ businessName: 'C2' });
  const la1 = profile({ businessName: 'LA1' });
  const la2 = profile({ businessName: 'LA2' });
  const lb1 = profile({ businessName: 'LB1' });

  pulse.putCanonical('loc', c1); // rev1（无目录，立即 ready）
  pulse.putListing('loc', 'dirA', la1); // rev2
  pulse.putListing('loc', 'dirB', lb1); // rev3：dirA@3、dirB@3 启动
  await tick();

  // dirA@3 完成，dirB@3 仍暂停：rev3 只完成一半，不得发布部分报告。
  await harness.resolveOne((s) => s.directory === 'dirA' && s.revision === 3);
  let report = pulse.getReport('loc');
  assert.deepEqual(
    { status: report.status, revision: report.revision },
    { status: 'pending', revision: 3 },
    '半个修订的评分不得发布为部分报告',
  );

  // 修改 canonical 和一个 listing：rev4、rev5 相继取代 rev3。
  pulse.putCanonical('loc', c2); // rev4：dirA@4、dirB@4 启动
  pulse.putListing('loc', 'dirA', la2); // rev5：dirA@5、dirB@5 启动
  await tick();
  report = pulse.getReport('loc');
  assert.deepEqual(
    { status: report.status, revision: report.revision },
    { status: 'pending', revision: 5 },
    '写入后旧报告必须立即失效',
  );

  // 交错完成：先让旧修订的剩余评分（含 rev2 遗留的 dirA@2）全部结束。
  await harness.resolveOne((s) => s.directory === 'dirA' && s.revision === 2);
  await harness.resolveOne((s) => s.directory === 'dirB' && s.revision === 3);
  report = pulse.getReport('loc');
  assert.deepEqual(
    { status: report.status, revision: report.revision },
    { status: 'pending', revision: 5 },
    '旧修订 rev3 完成后不得发布或覆盖',
  );

  await harness.resolveOne((s) => s.directory === 'dirA' && s.revision === 4);
  await harness.resolveOne((s) => s.directory === 'dirB' && s.revision === 4);
  report = pulse.getReport('loc');
  assert.deepEqual(
    { status: report.status, revision: report.revision },
    { status: 'pending', revision: 5 },
    '旧修订 rev4 完成后不得发布或覆盖',
  );

  // 新修订先完成 dirB@5：仍不得出现部分报告。
  await harness.resolveOne((s) => s.directory === 'dirB' && s.revision === 5);
  report = pulse.getReport('loc');
  assert.deepEqual(
    { status: report.status, revision: report.revision },
    { status: 'pending', revision: 5 },
    'rev5 只完成一半时不得发布部分报告',
  );

  await harness.resolveOne((s) => s.directory === 'dirA' && s.revision === 5);
  report = pulse.getReport('loc');
  assert.equal(report.status, 'ready');
  assert.equal(report.revision, 5);

  const ready = report as ReadyReport;
  // 报告必须整体来自 rev5 快照：canonical 是 C2，dirA 是 LA2，dirB 是 LB1。
  assert.equal(ready.canonical.businessName, 'C2');
  assert.equal(ready.listings['dirA']!.businessName, 'LA2');
  assert.equal(ready.listings['dirB']!.businessName, 'LB1');
  assert.deepEqual(
    ready.directories.map((d) => [d.directory, d.score]),
    [
      ['dirA', 75],
      ['dirB', 75],
    ],
  );
  for (const d of ready.directories) {
    assert.deepEqual(d.diffs, [
      {
        field: 'businessName',
        canonicalValue: 'C2',
        listingValue: d.directory === 'dirA' ? 'LA2' : 'LB1',
      },
    ]);
  }

  await pulse.whenIdle();
  // whenIdle 之后报告仍是最新修订。
  const finalReport = pulse.getReport('loc');
  assert.equal(finalReport.status, 'ready');
  assert.equal(finalReport.revision, 5);
});
