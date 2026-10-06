/** 上层提供的非递减逻辑时钟，返回毫秒时间戳。 */
export type Clock = () => number;

/** 消息投递状态（按消费组独立）。 */
export type DeliveryState = 'pending' | 'leased' | 'acked' | 'dead';

/** 领取到的一条消息及其回执。 */
export interface ClaimedMessage {
  messageId: number;
  payload: unknown;
  priority: number;
  /** 仅代表本组本次投递的回执，用于确认。 */
  receipt: string;
  /** 本回执的到期时刻（毫秒，到期时刻本身已失效）。 */
  expiresAt: number;
}

/** 指定消息在某个消费组中的投递状态视图。 */
export interface GroupDeliveryStatus {
  group: string;
  state: DeliveryState;
  /** 该组对该消息的成功领取次数。 */
  attempts: number;
}

export interface PipeLiteOptions {
  /** SQLite 文件路径，或 ':memory:'。 */
  path: string;
  /** 消费组名称，初始化时确定，1 至 8 个，之后不增删。 */
  groups: string[];
  /** 上层提供的非递减逻辑时钟（毫秒）。 */
  clock: Clock;
}
