import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionBonusLedger } from '../src/index.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const BONUS = 500_000;

test('乱序 revision：大 revision 先到，小 revision 后到不覆盖；knownSeq 前缀决定历史视图', () => {
  const ledger = new RetentionBonusLedger();
  const at = T0 + 90 * DAY;

  // revision 2 先到：恰好第 90 日离职（等于门槛，归属）
  const r2 = ledger.recordEmployment('r1', 2, T0, T0 + 90 * DAY, BONUS);
  // revision 1 后到：第 30 日离职（永不归属），不得覆盖 revision 2
  const r1 = ledger.recordEmployment('r1', 1, T0, T0 + 30 * DAY, BONUS);
  // revision 3 更晚到：第 89 日离职（永不归属）
  const r3 = ledger.recordEmployment('r1', 3, T0, T0 + 89 * DAY, BONUS);

  assert.ok(r2.seq < r1.seq && r1.seq < r3.seq);

  // knownSeq=0：前缀内无事实
  assert.deepEqual(ledger.read('r1', at, 0), {
    status: 'not_found',
    revision: null,
    vestedCents: 0,
    paidCents: 0,
    clawbackCents: 0,
  });

  // knownSeq 只含 revision 2：恰好等于门槛，归属
  assert.deepEqual(ledger.read('r1', at, r2.seq), {
    status: 'vested',
    revision: 2,
    vestedCents: BONUS,
    paidCents: 0,
    clawbackCents: 0,
  });

  // knownSeq 含迟到的小 revision 1：仍选 revision 2，不按到达顺序覆盖
  assert.deepEqual(ledger.read('r1', at, r1.seq), {
    status: 'vested',
    revision: 2,
    vestedCents: BONUS,
    paidCents: 0,
    clawbackCents: 0,
  });

  // knownSeq 含 revision 3：选最大 revision，第 89 日离职永不归属
  assert.deepEqual(ledger.read('r1', at, r3.seq), {
    status: 'unvested',
    revision: 3,
    vestedCents: 0,
    paidCents: 0,
    clawbackCents: 0,
  });
});

test('归属门槛：未达 90 日为零，恰好等于门槛归属，提前离职永不归属', () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment('ongoing', 1, T0, null, BONUS);
  ledger.recordEmployment('exact', 1, T0, T0 + 90 * DAY, BONUS);
  ledger.recordEmployment('early', 1, T0, T0 + 90 * DAY - 1, BONUS);
  const seq = ledger.recordEmployment('late', 1, T0, T0 + 120 * DAY, BONUS).seq;

  // 门槛前一毫秒：未归属
  assert.equal(ledger.read('ongoing', T0 + 90 * DAY - 1, seq).status, 'unvested');
  assert.equal(ledger.read('ongoing', T0 + 90 * DAY - 1, seq).vestedCents, 0);
  // 恰好到达门槛：归属
  assert.equal(ledger.read('ongoing', T0 + 90 * DAY, seq).vestedCents, BONUS);
  // 离职恰好等于门槛：归属
  assert.equal(ledger.read('exact', T0 + 90 * DAY, seq).vestedCents, BONUS);
  // 离职早于门槛 1ms：永不归属，之后任何时刻都是零
  assert.equal(ledger.read('early', T0 + 365 * DAY, seq).vestedCents, 0);
  assert.equal(ledger.read('early', T0 + 365 * DAY, seq).status, 'unvested');
  // 完成门槛后离职：不撤销归属
  assert.equal(ledger.read('late', T0 + 365 * DAY, seq).vestedCents, BONUS);
  assert.equal(ledger.read('late', T0 + 365 * DAY, seq).status, 'vested');
});

test('重复事实与重复命令返回原收据，不产生新 seq', () => {
  const ledger = new RetentionBonusLedger();
  const f1 = ledger.recordEmployment('r', 1, T0, null, BONUS);
  const f1dup = ledger.recordEmployment('r', 1, T0, null, BONUS);
  assert.deepEqual(f1dup, f1);
  // 重复事实没有消耗 seq
  const f2 = ledger.recordEmployment('r', 2, T0, null, BONUS);
  assert.equal(f2.seq, f1.seq + 1);

  const a1 = ledger.approve('cmd-a', 'r', T0 + 90 * DAY);
  const a1dup = ledger.approve('cmd-a', 'r', T0 + 90 * DAY);
  assert.deepEqual(a1dup, a1);
  assert.ok(a1.ok);

  const p1 = ledger.pay('cmd-p', 'r', T0 + 90 * DAY);
  const p1dup = ledger.pay('cmd-p', 'r', T0 + 90 * DAY);
  assert.deepEqual(p1dup, p1);
  assert.ok(p1.ok);
  if (a1.ok && p1.ok) {
    assert.equal(p1.seq, a1.seq + 1);
  }
});

test('approve 仅在已归属时成功；pay 需要当前 revision 的有效签核', () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment('r', 1, T0, null, BONUS);

  // 未归属时签核失败
  assert.deepEqual(ledger.approve('a-early', 'r', T0 + 89 * DAY), {
    ok: false,
    reason: 'not_vested',
  });
  // 无签核时付款失败
  assert.deepEqual(ledger.pay('p-noappr', 'r', T0 + 90 * DAY), {
    ok: false,
    reason: 'no_valid_approval',
  });

  const approve = ledger.approve('a-1', 'r', T0 + 90 * DAY);
  assert.ok(approve.ok);
  if (approve.ok) assert.equal(approve.revision, 1);

  // 新修订使旧签核失效
  ledger.recordEmployment('r', 2, T0, null, BONUS);
  assert.deepEqual(ledger.pay('p-stale', 'r', T0 + 91 * DAY), {
    ok: false,
    reason: 'no_valid_approval',
  });

  // 重新签核绑定 revision 2 后付款成功
  const approve2 = ledger.approve('a-2', 'r', T0 + 91 * DAY);
  assert.ok(approve2.ok);
  if (approve2.ok) assert.equal(approve2.revision, 2);
  const pay = ledger.pay('p-1', 'r', T0 + 91 * DAY);
  assert.ok(pay.ok);
  if (pay.ok) assert.equal(pay.amountCents, BONUS);
});

test('签核与付款按 seq 与 at 参与视图', () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment('r', 1, T0, null, BONUS);
  const approveAt = T0 + 95 * DAY;
  const approve = ledger.approve('a-1', 'r', approveAt);
  assert.ok(approve.ok);
  const payAt = T0 + 96 * DAY;
  const pay = ledger.pay('p-1', 'r', payAt);
  assert.ok(pay.ok);
  if (!approve.ok || !pay.ok) return;

  // 签核的 at 晚于查询时刻：不算已签核
  assert.equal(ledger.read('r', approveAt - 1, pay.seq).status, 'vested');
  // knownSeq 不含签核：不算已签核
  assert.equal(ledger.read('r', payAt, approve.seq - 1).status, 'vested');
  // 签核可见、付款不可见（knownSeq 不含付款）
  assert.deepEqual(ledger.read('r', payAt, approve.seq), {
    status: 'approved',
    revision: 1,
    vestedCents: BONUS,
    paidCents: 0,
    clawbackCents: 0,
  });
  // 付款的 at 晚于查询时刻：不算已付款
  assert.equal(ledger.read('r', payAt - 1, pay.seq).status, 'approved');
  // 付款可见
  assert.deepEqual(ledger.read('r', payAt, pay.seq), {
    status: 'paid',
    revision: 1,
    vestedCents: BONUS,
    paidCents: BONUS,
    clawbackCents: 0,
  });
});

test('付款后迟到修订推翻归属：全额追回；恢复归属后追回归零；终身只能付款一次', () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment('r', 1, T0, null, BONUS);
  const approve = ledger.approve('a-1', 'r', T0 + 90 * DAY);
  assert.ok(approve.ok);
  const pay = ledger.pay('p-1', 'r', T0 + 90 * DAY);
  assert.ok(pay.ok);
  if (!pay.ok) return;

  // 迟到修订：实际第 89 日离职，永不归属 → 全额应追回
  const late = ledger.recordEmployment('r', 2, T0, T0 + 89 * DAY, BONUS);
  assert.deepEqual(ledger.read('r', T0 + 90 * DAY, late.seq), {
    status: 'paid',
    revision: 2,
    vestedCents: 0,
    paidCents: BONUS,
    clawbackCents: BONUS,
  });

  // 再收到恢复归属的修订：追回归零，已付款不变
  const restored = ledger.recordEmployment('r', 3, T0, null, BONUS);
  assert.deepEqual(ledger.read('r', T0 + 90 * DAY, restored.seq), {
    status: 'paid',
    revision: 3,
    vestedCents: BONUS,
    paidCents: BONUS,
    clawbackCents: 0,
  });

  // 相同 commandId 重试：返回原收据，不产生新 seq
  const retry = ledger.pay('p-1', 'r', T0 + 92 * DAY);
  assert.deepEqual(retry, pay);

  // 换 commandId 重试：拒绝
  assert.deepEqual(ledger.pay('p-2', 'r', T0 + 92 * DAY), {
    ok: false,
    reason: 'already_paid',
  });

  // 重新签核后再付款：仍然拒绝
  const reapprove = ledger.approve('a-2', 'r', T0 + 92 * DAY);
  assert.ok(reapprove.ok);
  assert.deepEqual(ledger.pay('p-3', 'r', T0 + 93 * DAY), {
    ok: false,
    reason: 'already_paid',
  });

  // 历史成功收据不被更正改写：重新查询付款时刻的视图仍为已付款
  assert.equal(ledger.read('r', T0 + 90 * DAY, restored.seq).status, 'paid');
});

test('非重复命令的 at 必须按调用顺序不下降', () => {
  const ledger = new RetentionBonusLedger();
  ledger.recordEmployment('r', 1, T0, null, BONUS);
  const approve = ledger.approve('a-1', 'r', T0 + 90 * DAY);
  assert.ok(approve.ok);
  assert.deepEqual(ledger.pay('p-1', 'r', T0 + 89 * DAY), {
    ok: false,
    reason: 'non_monotonic_at',
  });
  // 重复命令不受单调性约束，仍返回原收据
  assert.deepEqual(ledger.approve('a-1', 'r', T0 + 90 * DAY), approve);
});

test('不存在的推荐与未知 referralId', () => {
  const ledger = new RetentionBonusLedger();
  assert.equal(ledger.read('ghost', T0, 100).status, 'not_found');
  assert.deepEqual(ledger.approve('a-1', 'ghost', T0), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(ledger.pay('p-1', 'ghost', T0), {
    ok: false,
    reason: 'not_found',
  });
});
