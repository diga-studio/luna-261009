/** 答题事件类型 */
export type EventKind = "incorrect" | "correct" | "mastered";

/** 历史答题事件（occurredAt 为 UTC 毫秒时间戳） */
export interface ReviewEvent {
  eventId: string;
  studentId: string;
  wordId: string;
  occurredAt: number;
  kind: EventKind;
}

/** 复习状态 */
export type ReviewStatus = "inactive" | "pending" | "mastered";

/** getState 返回的投影 */
export interface ReviewState {
  status: ReviewStatus;
  /** 当前间隔（天）；未激活时为 null */
  intervalDays: number | null;
  /** 到期日（UTC 毫秒时间戳，自然日起点）；未激活时为 null */
  dueAt: number | null;
}
