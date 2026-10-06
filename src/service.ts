import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isStaffEligible } from "./eligibility.js";
import {
  AcceptResult,
  CreateTaskInput,
  INVITATION_TTL_MS,
  InvitationView,
  ProcessExpiredResult,
  Target,
  TaskView,
} from "./types.js";

interface TaskRow {
  id: string;
  idempotency_key: string;
  target_type: string;
  target_id: string;
  service_time: number;
  status: string;
  candidates: string;
  accepted_staff_id: string | null;
  created_at: number;
}

interface InvitationRow {
  id: string;
  task_id: string;
  staff_id: string;
  issued_at: number;
  expires_at: number;
  status: string;
  seq: number;
}

export class DispatchService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createTask(input: CreateTaskInput, now: number): TaskView {
    const existing = this.findTaskByKey(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const taskId = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO tasks
             (id, idempotency_key, target_type, target_id, service_time, status, candidates, accepted_staff_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'inviting', ?, NULL, ?)`,
        )
        .run(
          taskId,
          input.idempotencyKey,
          input.target.type,
          input.target.id,
          input.serviceTime,
          JSON.stringify(input.candidates),
          now,
        );
      this.dispatchNext(taskId, input.target, input.serviceTime, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const view = this.getTask(taskId);
    if (!view) {
      throw new Error("task disappeared after creation");
    }
    return view;
  }

  acceptInvitation(invitationId: string, now: number): AcceptResult {
    const invitation = this.findInvitation(invitationId);
    if (!invitation) {
      return { ok: false, reason: "invitation_not_found", task: null };
    }
    if (invitation.status === "accepted") {
      return {
        ok: true,
        task: this.mustGetTask(invitation.task_id),
        invitation: toInvitationView(invitation),
      };
    }
    if (invitation.status === "expired" || invitation.expires_at <= now) {
      return {
        ok: false,
        reason: "invitation_expired",
        task: this.getTask(invitation.task_id),
      };
    }
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`UPDATE invitations SET status = 'accepted' WHERE id = ? AND status = 'pending'`)
        .run(invitationId);
      this.db
        .prepare(`UPDATE tasks SET status = 'accepted', accepted_staff_id = ? WHERE id = ?`)
        .run(invitation.staff_id, invitation.task_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const fresh = this.findInvitation(invitationId);
    return {
      ok: true,
      task: this.mustGetTask(invitation.task_id),
      invitation: toInvitationView(fresh ?? invitation),
    };
  }

  processExpiredInvitations(now: number): ProcessExpiredResult {
    const expired = this.db
      .prepare(
        `SELECT * FROM invitations
         WHERE status = 'pending' AND expires_at <= ?
         ORDER BY expires_at ASC, seq ASC`,
      )
      .all(now) as unknown as InvitationRow[];
    const expiredInvitationIds: string[] = [];
    const tasks: TaskView[] = [];
    for (const invitation of expired) {
      this.db.exec("BEGIN");
      try {
        this.db
          .prepare(`UPDATE invitations SET status = 'expired' WHERE id = ? AND status = 'pending'`)
          .run(invitation.id);
        const task = this.mustGetTaskRow(invitation.task_id);
        this.dispatchNext(
          task.id,
          { type: task.target_type as Target["type"], id: task.target_id },
          task.service_time,
          now,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      expiredInvitationIds.push(invitation.id);
      tasks.push(this.mustGetTask(invitation.task_id));
    }
    return { expiredInvitationIds, tasks };
  }

  getTask(taskId: string): TaskView | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as unknown as TaskRow | undefined;
    return row ? this.toTaskView(row) : null;
  }

  close(): void {
    this.db.close();
  }

  private dispatchNext(taskId: string, target: Target, serviceTime: number, now: number): void {
    const row = this.mustGetTaskRow(taskId);
    const candidates = JSON.parse(row.candidates) as string[];
    const invited = new Set(
      (
        this.db
          .prepare(`SELECT staff_id FROM invitations WHERE task_id = ?`)
          .all(taskId) as unknown as Array<{ staff_id: string }>
      ).map((entry) => entry.staff_id),
    );
    for (const staffId of candidates) {
      if (invited.has(staffId)) {
        continue;
      }
      if (!isStaffEligible(this.db, staffId, target, serviceTime, now)) {
        continue;
      }
      const seq = invited.size;
      this.db
        .prepare(
          `INSERT INTO invitations (id, task_id, staff_id, issued_at, expires_at, status, seq)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(randomUUID(), taskId, staffId, now, now + INVITATION_TTL_MS, seq);
      this.db.prepare(`UPDATE tasks SET status = 'inviting' WHERE id = ?`).run(taskId);
      return;
    }
    this.db.prepare(`UPDATE tasks SET status = 'unassignable' WHERE id = ?`).run(taskId);
  }

  private findTaskByKey(idempotencyKey: string): TaskView | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE idempotency_key = ?`)
      .get(idempotencyKey) as unknown as TaskRow | undefined;
    return row ? this.toTaskView(row) : null;
  }

  private findInvitation(invitationId: string): InvitationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM invitations WHERE id = ?`)
      .get(invitationId) as unknown as InvitationRow | undefined;
    return row ?? null;
  }

  private mustGetTaskRow(taskId: string): TaskRow {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as unknown as TaskRow | undefined;
    if (!row) {
      throw new Error(`task not found: ${taskId}`);
    }
    return row;
  }

  private mustGetTask(taskId: string): TaskView {
    const view = this.getTask(taskId);
    if (!view) {
      throw new Error(`task not found: ${taskId}`);
    }
    return view;
  }

  private toTaskView(row: TaskRow): TaskView {
    const invitation = this.db
      .prepare(
        `SELECT * FROM invitations
         WHERE task_id = ? AND status IN ('pending', 'accepted')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(row.id) as unknown as InvitationRow | undefined;
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      target: { type: row.target_type as Target["type"], id: row.target_id },
      serviceTime: row.service_time,
      status: row.status as TaskView["status"],
      candidates: JSON.parse(row.candidates) as string[],
      acceptedStaffId: row.accepted_staff_id,
      currentInvitation: invitation ? toInvitationView(invitation) : null,
      createdAt: row.created_at,
    };
  }
}

function toInvitationView(row: InvitationRow): InvitationView {
  return {
    id: row.id,
    taskId: row.task_id,
    staffId: row.staff_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    status: row.status as InvitationView["status"],
  };
}
