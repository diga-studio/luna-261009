/** ISO-8601 UTC timestamp string, e.g. "2026-03-07T13:00:00Z". */
export type UtcTimestamp = string;

/** Preset outcome of a single attempt: true = success, false = failure. */
export type AttemptOutcome = boolean;

export interface SubmitMessageInput {
  /** Contact identifier. */
  contactId: string;
  /** Template identifier; identical template ids are treated as duplicates. */
  templateId: string;
  /** Scheduled UTC time (earliest first-attempt time). */
  scheduledAt: UtcTimestamp;
  /** Preset outcomes per attempt, at most 3 entries. */
  outcomes: AttemptOutcome[];
}

export type MessageStatus = "pending" | "delivered" | "exhausted";

export interface AttemptRecord {
  messageId: number;
  contactId: string;
  templateId: string;
  /** 1-based attempt number. */
  attemptNumber: number;
  /** Actual UTC time the attempt happened. */
  attemptedAt: UtcTimestamp;
  success: boolean;
}

export interface MessageView {
  messageId: number;
  contactId: string;
  templateId: string;
  scheduledAt: UtcTimestamp;
  status: MessageStatus;
  attempts: AttemptRecord[];
}
