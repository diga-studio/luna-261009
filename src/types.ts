/** 事件类型：曝光或转化 */
export type EventType = "exposure" | "conversion";

/** 上报的单条事件 */
export interface ExperimentEvent {
  /** 事件标识（用于去重） */
  eventId: string;
  /** 访客标识 */
  visitorId: string;
  /** 变体标识 */
  variantId: string;
  /** 事件类型 */
  type: EventType;
}

/** 单个变体的实时统计 */
export interface VariantStats {
  variantId: string;
  /** 有效曝光人数 */
  n: number;
  /** 有效转化人数 */
  c: number;
}

/** 锁定证据：首次满足判胜条件时刻的快照 */
export interface LockInfo {
  /** 触发锁定的事件标识 */
  triggerEventId: string;
  /** 锁定的赢家变体 */
  winnerVariantId: string;
  /** 锁定时所有变体的 n、c 快照 */
  stats: VariantStats[];
}

/** 实验结果：实时统计 + 锁定结果 */
export interface ExperimentResult {
  experimentId: string;
  /** 实时统计（锁定后仍继续更新） */
  stats: VariantStats[];
  /** 锁定结果；未锁定时为 null */
  lock: LockInfo | null;
}
