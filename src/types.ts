/** 消息预设的单次尝试结果 */
export type AttemptOutcome = "success" | "failure";

/** 消息当前状态 */
export type MessageStatus = "pending" | "delivered" | "exhausted";

/** 提交消息时的输入 */
export interface MessageInput {
  /** 联系人标识 */
  contactId: string;
  /** 模板标识 */
  templateId: string;
  /** 预约 UTC 时刻（ISO 字符串或 Date） */
  scheduledAt: string | Date;
  /** 预设结果，按尝试顺序生效，最多 3 个 */
  outcomes: AttemptOutcome[];
}

/** 一条已登记的尝试记录 */
export interface AttemptRecord {
  messageId: string;
  contactId: string;
  templateId: string;
  /** 第几次尝试（1 起） */
  attemptNumber: number;
  /** 实际尝试发生的 UTC 时刻 */
  attemptedAt: Date;
  outcome: AttemptOutcome;
}

/** 消息对外可见的视图 */
export interface MessageView {
  id: string;
  contactId: string;
  templateId: string;
  scheduledAt: Date;
  status: MessageStatus;
  attempts: AttemptRecord[];
}
