/** 上层提供的非递减逻辑时钟，精确到毫秒。 */
export type Clock = () => number;

/** 消息优先级范围：1（最低）至 10（最高）。 */
export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 10;

/** 单次领取条数范围：1 至 50。 */
export const MIN_CLAIM_LIMIT = 1;
export const MAX_CLAIM_LIMIT = 50;

/** 消费组数量范围：1 至 8。 */
export const MIN_GROUPS = 1;
export const MAX_GROUPS = 8;

/** 租约（持有）时长：领取后 30 秒。 */
export const LEASE_DURATION_MS = 30_000;

/** 最大投递尝试次数：第 5 次超时后进入死信。 */
export const MAX_ATTEMPTS = 5;

/** 某条消息在某个消费组内的投递状态。 */
export type DeliveryState = "pending" | "leased" | "acked" | "dead";

/** 领取回执：仅代表该组本次投递，对其他组和其他投递轮次无效。 */
export interface Receipt {
  readonly messageId: number;
  readonly group: string;
  readonly token: string;
  readonly expiresAt: number;
}

/** claim 返回的单条消息：原始载荷 + 本组本次投递的回执。 */
export interface ClaimedMessage {
  readonly messageId: number;
  readonly payload: unknown;
  readonly priority: number;
  readonly receipt: Receipt;
}

/** 指定消息在单个消费组中的投递状态视图。 */
export interface GroupDeliveryStatus {
  readonly group: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly leaseExpiresAt: number | null;
}

export interface PipeLiteOptions {
  /** SQLite 文件路径（同进程两个实例可指向同一文件）。 */
  readonly path: string;
  /** 消费组名称，初始化时确定，1 至 8 个，之后不增删。 */
  readonly groups: readonly string[];
  /** 上层提供的非递减逻辑时钟（毫秒）。缺省为 Date.now。 */
  readonly clock?: Clock;
}
