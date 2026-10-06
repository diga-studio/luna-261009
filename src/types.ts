export type TargetType = "student" | "class";

export interface TargetRef {
  type: TargetType;
  id: string;
}

export type TaskStatus = "inviting" | "accepted" | "unassignable";

export interface InvitationView {
  invitationId: number;
  workerId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface TaskView {
  taskId: number;
  idempotencyKey: string;
  target: TargetRef;
  serviceTimeMs: number;
  status: TaskStatus;
  currentInvitation: InvitationView | null;
  acceptedWorkerId: string | null;
}

export interface CreateTaskInput {
  idempotencyKey: string;
  target: TargetRef;
  serviceTimeMs: number;
  candidates: string[];
  nowMs: number;
}

export type AcceptFailureReason =
  | "invitation_not_found"
  | "invitation_expired"
  | "invitation_not_current";

export interface AcceptResult {
  ok: boolean;
  reason?: AcceptFailureReason;
  task?: TaskView;
}

export interface ProcessExpiredResult {
  expiredInvitationIds: number[];
}

export const INVITATION_TTL_MS = 10 * 60 * 1000;
export const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
export const MAX_OCCUPANCY_PER_24H = 3;
export const MIN_TARGET_GAP_MS = 14 * 24 * 60 * 60 * 1000;
