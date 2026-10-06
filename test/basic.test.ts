import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LocalPulse } from '../src/localPulse';
import { ScoringHarness, profile, tick } from './helpers';
import type { ReadyReport } from '../src/types';

test('putCanonical 无目录时立即 ready，目录集合为空', async () => {
  const pulse = new LocalPulse();
  const rev = pulse.putCanonical('loc1', profile());
  assert.equal(rev, 1);
  const report = pulse.getReport('loc1');
  assert.equal(report.status, 'ready');
  assert.equal(report.revision, 1);
  if (report.status === 'ready') {
    assert.deepEqual(report.directories, []);
    assert.deepEqual(report.listings, {});
  }
  await pulse.whenIdle();
});

test('默认评分：相等字段各 25 分，差异字段输出两侧值', async () => {
  const pulse = new LocalPulse();
  pulse.putCanonical('loc1', profile());
  pulse.putListing('loc1', 'yelp', profile({ phone: '555-9999' }));
  pulse.putListing('loc1', 'bing', profile({ hours: ['9-17', '9-17', '9-17', '9-17', '9-17', '10-14', '10-14'] }));
  await pulse.whenIdle();

  const report = pulse.getReport('loc1') as ReadyReport;
  assert.equal(report.status, 'ready');
  assert.equal(report.revision, 3);

  const yelp = report.directories.find((d) => d.directory === 'yelp')!;
  assert.equal(yelp.score, 75);
  assert.deepEqual(yelp.diffs, [{ field: 'phone', canonicalValue: '555-0100', listingValue: '555-9999' }]);

  const bing = report.directories.find((d) => d.directory === 'bing')!;
  assert.equal(bing.score, 75);
  assert.deepEqual(bing.diffs, [
    {
      field: 'hours',
      canonicalValue: ['9-17', '9-17', '9-17', '9-17', '9-17', '10-14', 'closed'],
      listingValue: ['9-17', '9-17', '9-17', '9-17', '9-17', '10-14', '10-14'],
    },
  ]);
});

test('完全一致的 listing 得 100 分且无差异', async () => {
  const pulse = new LocalPulse();
  pulse.putCanonical('loc1', profile());
  pulse.putListing('loc1', 'yelp', profile());
  await pulse.whenIdle();
  const report = pulse.getReport('loc1') as ReadyReport;
  assert.equal(report.directories[0]!.score, 100);
  assert.deepEqual(report.directories[0]!.diffs, []);
});

test('注入的评分函数收到 locationId、directory、revision 与快照', async () => {
  const harness = new ScoringHarness();
  const pulse = new LocalPulse({ scoreFn: harness.scoreFn });
  pulse.putCanonical('loc1', profile());
  pulse.putListing('loc1', 'yelp', profile({ phone: '1' }));
  pulse.putListing('loc1', 'bing', profile({ phone: '2' }));
  await tick();

  assert.deepEqual(
    harness.started.map((s) => [s.locationId, s.directory, s.revision]),
    [
      ['loc1', 'yelp', 2],
      ['loc1', 'yelp', 3],
      ['loc1', 'bing', 3],
    ],
  );
  await harness.resolveAll();
  await pulse.whenIdle();
  const report = pulse.getReport('loc1') as ReadyReport;
  assert.equal(report.revision, 3);
  assert.equal(report.directories.length, 2);
});

test('getReport 对未知门店返回 pending', () => {
  const pulse = new LocalPulse();
  assert.deepEqual(pulse.getReport('nope'), { status: 'pending', locationId: 'nope', revision: 0 });
});

test('putListing 在 canonical 不存在时抛错', () => {
  const pulse = new LocalPulse();
  assert.throws(() => pulse.putListing('loc1', 'yelp', profile()));
});
