import type {
  ApproveReceipt,
  ApproveResult,
  CommandReceipt,
  EmploymentReceipt,
  Millis,
  PayReceipt,
  PayResult,
  ReadView,
} from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 连续 90 个 24 小时后全额归属 */
const VESTING_PERIOD_MS = 90 * DAY_MS;

interface FactRecord {
  seq: number;
  revision: number;
  hiredAt: Millis;
  endedAt: Millis | null;
  bonusCents: number;
}

interface ApprovalRecord {
  seq: number;
  referralId: string;
  /** 签核绑定的 revision */
  revision: number;
  at: Millis;
}

interface PaymentRecord {
  seq: number;
  referralId: string;
  at: Millis;
  amountCents: number;
}

export class RetentionBonusLedger {
  private nextSeq = 1;
  private readonly facts = new Map<string, Map<number, FactRecord>>();
  private readonly commandReceipts = new Map<string, CommandReceipt>();
  private readonly approvals: ApprovalRecord[] = [];
  private readonly payments: PaymentRecord[] = [];
  private lastCommandAt: Millis | null = null;

  recordEmployment(
    referralId: string,
    revision: number,
    hiredAt: Millis,
    endedAt: Millis | null,
    bonusCents: number,
  ): EmploymentReceipt {
    let byRevision = this.facts.get(referralId);
    const existing = byRevision?.get(revision);
    if (existing) {
      return { ok: true, seq: existing.seq };
    }
    const record: FactRecord = {
      seq: this.nextSeq++,
      revision,
      hiredAt,
      endedAt,
      bonusCents,
    };
    if (!byRevision) {
      byRevision = new Map();
      this.facts.set(referralId, byRevision);
    }
    byRevision.set(revision, record);
    return { ok: true, seq: record.seq };
  }

  approve(commandId: string, referralId: string, at: Millis): ApproveResult {
    const duplicate = this.commandReceipts.get(commandId);
    if (duplicate) {
      if (duplicate.kind !== 'approve') {
        return { ok: false, reason: 'not_found' };
      }
      return duplicate;
    }
    if (this.lastCommandAt !== null && at < this.lastCommandAt) {
      return { ok: false, reason: 'non_monotonic_at' };
    }
    const fact = this.currentFact(referralId);
    if (!fact) {
      return { ok: false, reason: 'not_found' };
    }
    if (this.vestedAmount(fact, at) <= 0) {
      return { ok: false, reason: 'not_vested' };
    }
    const receipt: ApproveReceipt = {
      ok: true,
      kind: 'approve',
      seq: this.nextSeq++,
      referralId,
      revision: fact.revision,
    };
    this.commandReceipts.set(commandId, receipt);
    this.approvals.push({
      seq: receipt.seq,
      referralId,
      revision: fact.revision,
      at,
    });
    this.lastCommandAt = at;
    return receipt;
  }

  pay(commandId: string, referralId: string, at: Millis): PayResult {
    const duplicate = this.commandReceipts.get(commandId);
    if (duplicate) {
      if (duplicate.kind !== 'pay') {
        return { ok: false, reason: 'not_found' };
      }
      return duplicate;
    }
    if (this.lastCommandAt !== null && at < this.lastCommandAt) {
      return { ok: false, reason: 'non_monotonic_at' };
    }
    const fact = this.currentFact(referralId);
    if (!fact) {
      return { ok: false, reason: 'not_found' };
    }
    if (this.payments.some((p) => p.referralId === referralId)) {
      return { ok: false, reason: 'already_paid' };
    }
    if (this.vestedAmount(fact, at) <= 0) {
      return { ok: false, reason: 'not_vested' };
    }
    const hasValidApproval = this.approvals.some(
      (a) => a.referralId === referralId && a.revision === fact.revision,
    );
    if (!hasValidApproval) {
      return { ok: false, reason: 'no_valid_approval' };
    }
    const receipt: PayReceipt = {
      ok: true,
      kind: 'pay',
      seq: this.nextSeq++,
      referralId,
      amountCents: fact.bonusCents,
    };
    this.commandReceipts.set(commandId, receipt);
    this.payments.push({
      seq: receipt.seq,
      referralId,
      at,
      amountCents: fact.bonusCents,
    });
    this.lastCommandAt = at;
    return receipt;
  }

  read(referralId: string, at: Millis, knownSeq: number): ReadView {
    const byRevision = this.facts.get(referralId);
    let best: FactRecord | null = null;
    if (byRevision) {
      for (const fact of byRevision.values()) {
        if (fact.seq <= knownSeq && (!best || fact.revision > best.revision)) {
          best = fact;
        }
      }
    }
    if (!best) {
      return {
        status: 'not_found',
        revision: null,
        vestedCents: 0,
        paidCents: 0,
        clawbackCents: 0,
      };
    }
    const vestedCents = this.vestedAmount(best, at);
    const paidCents = this.payments
      .filter(
        (p) => p.referralId === referralId && p.seq <= knownSeq && p.at <= at,
      )
      .reduce((sum, p) => sum + p.amountCents, 0);
    const hasValidApproval = this.approvals.some(
      (a) =>
        a.referralId === referralId &&
        a.revision === best.revision &&
        a.seq <= knownSeq &&
        a.at <= at,
    );
    const clawbackCents = Math.max(0, paidCents - vestedCents);
    const status =
      paidCents > 0
        ? 'paid'
        : hasValidApproval
          ? 'approved'
          : vestedCents > 0
            ? 'vested'
            : 'unvested';
    return {
      status,
      revision: best.revision,
      vestedCents,
      paidCents,
      clawbackCents,
    };
  }

  /** 当前（不限 seq）revision 最大的修订 */
  private currentFact(referralId: string): FactRecord | null {
    const byRevision = this.facts.get(referralId);
    if (!byRevision) {
      return null;
    }
    let best: FactRecord | null = null;
    for (const fact of byRevision.values()) {
      if (!best || fact.revision > best.revision) {
        best = fact;
      }
    }
    return best;
  }

  /** 归属金额：离职早于门槛则永不归属；恰好等于门槛归属；未达门槛为零 */
  private vestedAmount(fact: FactRecord, at: Millis): number {
    const threshold = fact.hiredAt + VESTING_PERIOD_MS;
    if (fact.endedAt !== null && fact.endedAt < threshold) {
      return 0;
    }
    return at >= threshold ? fact.bonusCents : 0;
  }
}
