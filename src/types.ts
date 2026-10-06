export type TargetType = "student" | "class";

export interface Target {
  type: TargetType;
  id: string;
}

export type TaskStatus = "inviting" | "accepted" | "unassignable";

export type InvitationStatus = "pending" | "accepted" | "expired";

export interface CreateTaskInput {
  idempotencyKey: string;
  target: Target;
  serviceTime: number;
  candidates: string[];
}

export interface InvitationView {
  id: string;
  taskId: string;
  staffId: string;
  issuedAt: number;
  expiresAt: number;
  status: InvitationStatus;
}

export interface TaskView {
  id: string;
  idempotencyKey: string;
  target: Target;
  serviceTime: number;
  status: TaskStatus;
  candidates: string[];
  acceptedStaffId: string | null;
  currentInvitation: InvitationView | null;
  createdAt: number;
}

export type AcceptResult =
  | { ok: true; task: TaskView; invitation: InvitationView }
  | { ok: false; reason: AcceptFailureReason; task: TaskView | null };

export type AcceptFailureReason = "invitation_not_found" | "invitation_expired";

export interface ProcessExpiredResult {
  expiredInvitationIds: string[];
  tasks: TaskView[];
}

export const INVITATION_TTL_MS = 10 * 60 * 1000;
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QUOTA_MAX_PER_WINDOW = 3;
export const SAME_TARGET_MIN_GAP_MS = 14 * 24 * 60 * 60 * 1000;
