export type EventKind = "incorrect" | "correct" | "mastered";

export interface ReviewEvent {
  eventId: string;
  studentId: string;
  wordId: string;
  /** UTC 毫秒时间戳 */
  occurredAt: number;
  kind: EventKind;
}

export type ReviewStatus = "inactive" | "pending" | "mastered";

export interface ReviewState {
  status: ReviewStatus;
  /** 当前间隔（天）；未激活或已掌握时为 null */
  intervalDays: number | null;
  /** 到期日（UTC 当日 00:00 的毫秒时间戳）；未激活或已掌握时为 null */
  dueAt: number | null;
}
