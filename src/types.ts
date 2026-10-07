/** UTC 毫秒时间戳 */
export type Millis = number;

/** recordEmployment 的收据 */
export interface EmploymentReceipt {
  ok: true;
  seq: number;
}

/** approve 成功收据，绑定签核时的 revision */
export interface ApproveReceipt {
  ok: true;
  kind: 'approve';
  seq: number;
  referralId: string;
  revision: number;
}

/** pay 成功收据 */
export interface PayReceipt {
  ok: true;
  kind: 'pay';
  seq: number;
  referralId: string;
  amountCents: number;
}

export type CommandReceipt = ApproveReceipt | PayReceipt;

export type FailureReason =
  | 'not_found'
  | 'not_vested'
  | 'no_valid_approval'
  | 'already_paid'
  | 'non_monotonic_at';

export interface Failure {
  ok: false;
  reason: FailureReason;
}

export type ApproveResult = ApproveReceipt | Failure;
export type PayResult = PayReceipt | Failure;

export type BonusStatus =
  | 'not_found'
  | 'unvested'
  | 'vested'
  | 'approved'
  | 'paid';

/** read 的视图结果 */
export interface ReadView {
  status: BonusStatus;
  /** 视图内选中的 revision；不存在时为 null */
  revision: number | null;
  /** 查询时刻的归属金额 */
  vestedCents: number;
  /** 视图内不可逆付款金额 */
  paidCents: number;
  /** 应追回金额：已付款超过归属的部分 */
  clawbackCents: number;
}
