export type Millis = number;

export const VESTING_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

export interface EmploymentReceipt {
  seq: number;
  referralId: string;
  revision: number;
}

export interface ApproveReceipt {
  seq: number;
  commandId: string;
  referralId: string;
  revision: number;
}

export interface PayReceipt {
  seq: number;
  commandId: string;
  referralId: string;
  revision: number;
  amountCents: number;
}

export type CommandResult<T> =
  | { ok: true; receipt: T }
  | { ok: false; error: string };

export type BonusStatus = "paid" | "approved" | "vested" | "unvested";

export interface BonusView {
  exists: boolean;
  status: BonusStatus | "not_found";
  revision: number | null;
  vestedCents: number;
  paidCents: number;
  clawbackCents: number;
}

interface FactRecord {
  seq: number;
  referralId: string;
  revision: number;
  hiredAt: Millis;
  endedAt: Millis | null;
  bonusCents: number;
}

interface ApprovalRecord {
  seq: number;
  commandId: string;
  referralId: string;
  revision: number;
  at: Millis;
}

interface PaymentRecord {
  seq: number;
  commandId: string;
  referralId: string;
  revision: number;
  at: Millis;
  amountCents: number;
}

function vestedCentsAt(fact: FactRecord, at: Millis): number {
  if (fact.endedAt !== null && fact.endedAt - fact.hiredAt < VESTING_THRESHOLD_MS) {
    return 0;
  }
  return at - fact.hiredAt >= VESTING_THRESHOLD_MS ? fact.bonusCents : 0;
}

export class RetentionBonusLedger {
  private seqCounter = 0;
  private facts = new Map<string, Map<number, FactRecord>>();
  private factReceipts = new Map<string, EmploymentReceipt>();
  private approvals: ApprovalRecord[] = [];
  private payments: PaymentRecord[] = [];
  private approveCommands = new Map<string, CommandResult<ApproveReceipt>>();
  private payCommands = new Map<string, CommandResult<PayReceipt>>();
  private lastCommandAt = new Map<string, Millis>();

  get currentSeq(): number {
    return this.seqCounter;
  }

  recordEmployment(
    referralId: string,
    revision: number,
    hiredAt: Millis,
    endedAt: Millis | null,
    bonusCents: number
  ): EmploymentReceipt {
    const key = `${referralId}${revision}`;
    const existing = this.factReceipts.get(key);
    if (existing) return existing;

    const seq = ++this.seqCounter;
    const fact: FactRecord = { seq, referralId, revision, hiredAt, endedAt, bonusCents };
    let byRevision = this.facts.get(referralId);
    if (!byRevision) {
      byRevision = new Map();
      this.facts.set(referralId, byRevision);
    }
    byRevision.set(revision, fact);
    const receipt: EmploymentReceipt = { seq, referralId, revision };
    this.factReceipts.set(key, receipt);
    return receipt;
  }

  approve(commandId: string, referralId: string, at: Millis): CommandResult<ApproveReceipt> {
    const existing = this.approveCommands.get(commandId);
    if (existing) return existing;

    const result = this.doApprove(commandId, referralId, at);
    if (result.ok) this.approveCommands.set(commandId, result);
    return result;
  }

  pay(commandId: string, referralId: string, at: Millis): CommandResult<PayReceipt> {
    const existing = this.payCommands.get(commandId);
    if (existing) return existing;

    const result = this.doPay(commandId, referralId, at);
    if (result.ok) this.payCommands.set(commandId, result);
    return result;
  }

  read(referralId: string, at: Millis, knownSeq: number): BonusView {
    const fact = this.latestFact(referralId, knownSeq);
    if (!fact) {
      return {
        exists: false,
        status: "not_found",
        revision: null,
        vestedCents: 0,
        paidCents: 0,
        clawbackCents: 0,
      };
    }

    const vested = vestedCentsAt(fact, at);
    const payment = this.payments.find(
      (p) => p.referralId === referralId && p.seq <= knownSeq && p.at <= at
    );
    const paid = payment ? payment.amountCents : 0;
    const clawback = Math.max(0, paid - vested);

    let status: BonusStatus;
    if (payment) {
      status = "paid";
    } else {
      const approved = this.approvals.some(
        (a) =>
          a.referralId === referralId &&
          a.revision === fact.revision &&
          a.seq <= knownSeq &&
          a.at <= at
      );
      if (approved) status = "approved";
      else if (vested > 0) status = "vested";
      else status = "unvested";
    }

    return {
      exists: true,
      status,
      revision: fact.revision,
      vestedCents: vested,
      paidCents: paid,
      clawbackCents: clawback,
    };
  }

  private doApprove(
    commandId: string,
    referralId: string,
    at: Millis
  ): CommandResult<ApproveReceipt> {
    const orderError = this.checkCommandOrder(referralId, at);
    if (orderError) return { ok: false, error: orderError };

    const fact = this.latestFact(referralId, this.seqCounter);
    if (!fact) return { ok: false, error: "employment not found" };
    if (vestedCentsAt(fact, at) <= 0) {
      return { ok: false, error: "bonus not vested" };
    }

    const seq = ++this.seqCounter;
    const receipt: ApproveReceipt = { seq, commandId, referralId, revision: fact.revision };
    this.approvals.push({ seq, commandId, referralId, revision: fact.revision, at });
    this.lastCommandAt.set(referralId, at);
    return { ok: true, receipt };
  }

  private doPay(
    commandId: string,
    referralId: string,
    at: Millis
  ): CommandResult<PayReceipt> {
    const orderError = this.checkCommandOrder(referralId, at);
    if (orderError) return { ok: false, error: orderError };

    if (this.payments.some((p) => p.referralId === referralId)) {
      return { ok: false, error: "bonus already paid" };
    }
    const fact = this.latestFact(referralId, this.seqCounter);
    if (!fact) return { ok: false, error: "employment not found" };
    if (vestedCentsAt(fact, at) <= 0) {
      return { ok: false, error: "bonus not vested" };
    }
    const approved = this.approvals.some(
      (a) => a.referralId === referralId && a.revision === fact.revision
    );
    if (!approved) return { ok: false, error: "no valid approval for current revision" };

    const seq = ++this.seqCounter;
    const receipt: PayReceipt = {
      seq,
      commandId,
      referralId,
      revision: fact.revision,
      amountCents: fact.bonusCents,
    };
    this.payments.push({
      seq,
      commandId,
      referralId,
      revision: fact.revision,
      at,
      amountCents: fact.bonusCents,
    });
    this.lastCommandAt.set(referralId, at);
    return { ok: true, receipt };
  }

  private checkCommandOrder(referralId: string, at: Millis): string | null {
    const last = this.lastCommandAt.get(referralId);
    if (last !== undefined && at < last) {
      return "command timestamps must be non-decreasing";
    }
    return null;
  }

  private latestFact(referralId: string, maxSeq: number): FactRecord | null {
    const byRevision = this.facts.get(referralId);
    if (!byRevision) return null;
    let best: FactRecord | null = null;
    for (const fact of byRevision.values()) {
      if (fact.seq > maxSeq) continue;
      if (!best || fact.revision > best.revision) best = fact;
    }
    return best;
  }
}
