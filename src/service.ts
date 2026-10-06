import { DatabaseSync } from "node:sqlite";
import { canOccupy, type OccupancyEntry } from "./eligibility.js";
import type {
  AcceptResult,
  CreateTaskInput,
  ProcessExpiredResult,
  TargetRef,
  TaskView,
} from "./types.js";
import { INVITATION_TTL_MS } from "./types.js";

interface TaskRow {
  id: number;
  idempotency_key: string;
  target_type: string;
  target_id: string;
  service_time_ms: number;
  candidates_json: string;
  status: string;
  created_at_ms: number;
}

interface InvitationRow {
  id: number;
  task_id: number;
  worker_id: string;
  seq: number;
  issued_at_ms: number;
  expires_at_ms: number;
  status: string;
}

export class DispatchService {
  constructor(private readonly db: DatabaseSync) {
  }

  createTask(input: CreateTaskInput): TaskView {
    return this.inTransaction(() => {
      const existing = this.findTaskByKey(input.idempotencyKey);
      if (existing !== null) {
        return this.toView(existing, input.nowMs);
      }
      const result = this.db
        .prepare(
          `INSERT INTO tasks
             (idempotency_key, target_type, target_id, service_time_ms,
              candidates_json, status, created_at_ms)
           VALUES (?, ?, ?, ?, ?, 'inviting', ?)`,
        )
        .run(
          input.idempotencyKey,
          input.target.type,
          input.target.id,
          input.serviceTimeMs,
          JSON.stringify(input.candidates),
          input.nowMs,
        );
      const taskId = Number(result.lastInsertRowid);
      this.dispatchNext(taskId, input.nowMs);
      return this.toView(this.getTaskRow(taskId), input.nowMs);
    });
  }

  acceptInvitation(invitationId: number, nowMs: number): AcceptResult {
    return this.inTransaction(() => {
      const invitation = this.getInvitationRow(invitationId);
      if (invitation === null) {
        return { ok: false, reason: "invitation_not_found" };
      }
      if (invitation.status === "accepted") {
        return { ok: true, task: this.toView(this.getTaskRow(invitation.task_id), nowMs) };
      }
      if (invitation.status !== "pending") {
        return { ok: false, reason: "invitation_expired" };
      }
      if (invitation.expires_at_ms <= nowMs) {
        this.db
          .prepare(`UPDATE invitations SET status = 'expired' WHERE id = ?`)
          .run(invitation.id);
        return { ok: false, reason: "invitation_expired" };
      }
      const task = this.getTaskRow(invitation.task_id);
      if (task.status !== "inviting") {
        return { ok: false, reason: "invitation_not_current" };
      }
      this.db
        .prepare(`UPDATE invitations SET status = 'accepted' WHERE id = ?`)
        .run(invitation.id);
      this.db
        .prepare(`UPDATE tasks SET status = 'accepted' WHERE id = ?`)
        .run(task.id);
      return { ok: true, task: this.toView(this.getTaskRow(task.id), nowMs) };
    });
  }

  processExpiredInvitations(nowMs: number): ProcessExpiredResult {
    return this.inTransaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM invitations
           WHERE status = 'pending' AND expires_at_ms <= ?
           ORDER BY id`,
        )
        .all(nowMs) as unknown as InvitationRow[];
      const expiredInvitationIds: number[] = [];
      for (const row of rows) {
        this.db
          .prepare(`UPDATE invitations SET status = 'expired' WHERE id = ?`)
          .run(row.id);
        expiredInvitationIds.push(row.id);
        this.dispatchNext(row.task_id, nowMs);
      }
      return { expiredInvitationIds };
    });
  }

  getTask(taskId: number, nowMs?: number): TaskView | null {
    const row = this.findTaskRow(taskId);
    if (row === null) {
      return null;
    }
    return this.toView(row, nowMs);
  }

  private dispatchNext(taskId: number, nowMs: number): void {
    const task = this.getTaskRow(taskId);
    if (task.status !== "inviting") {
      return;
    }
    const candidates = JSON.parse(task.candidates_json) as string[];
    const target: TargetRef = {
      type: task.target_type as TargetRef["type"],
      id: task.target_id,
    };
    const invitedRows = this.db
      .prepare(`SELECT worker_id FROM invitations WHERE task_id = ?`)
      .all(taskId) as unknown as Array<{ worker_id: string }>;
    const invited = new Set(invitedRows.map((row) => row.worker_id));
    for (const workerId of candidates) {
      if (invited.has(workerId)) {
        continue;
      }
      const occupied = this.loadOccupancy(workerId, nowMs);
      if (canOccupy(occupied, target, task.service_time_ms)) {
        this.db
          .prepare(
            `INSERT INTO invitations
               (task_id, worker_id, seq, issued_at_ms, expires_at_ms, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
          )
          .run(
            taskId,
            workerId,
            invited.size + 1,
            nowMs,
            nowMs + INVITATION_TTL_MS,
          );
        return;
      }
    }
    this.db
      .prepare(`UPDATE tasks SET status = 'unassignable' WHERE id = ?`)
      .run(taskId);
  }

  private loadOccupancy(workerId: string, nowMs: number): OccupancyEntry[] {
    const rows = this.db
      .prepare(
        `SELECT t.target_type, t.target_id, t.service_time_ms
         FROM invitations i
         JOIN tasks t ON t.id = i.task_id
         WHERE i.worker_id = ?
           AND (i.status = 'accepted'
                OR (i.status = 'pending' AND i.expires_at_ms > ?))`,
      )
      .all(workerId, nowMs) as unknown as Array<{
      target_type: string;
      target_id: string;
      service_time_ms: number;
    }>;
    return rows.map((row) => ({
      target: {
        type: row.target_type as TargetRef["type"],
        id: row.target_id,
      },
      serviceTimeMs: row.service_time_ms,
    }));
  }

  private toView(task: TaskRow, nowMs?: number): TaskView {
    const invitations = this.db
      .prepare(`SELECT * FROM invitations WHERE task_id = ? ORDER BY id`)
      .all(task.id) as unknown as InvitationRow[];
    let currentInvitation: TaskView["currentInvitation"] = null;
    let acceptedWorkerId: string | null = null;
    for (const invitation of invitations) {
      if (invitation.status === "accepted") {
        acceptedWorkerId = invitation.worker_id;
      } else if (
        invitation.status === "pending" &&
        (nowMs === undefined || invitation.expires_at_ms > nowMs)
      ) {
        currentInvitation = {
          invitationId: invitation.id,
          workerId: invitation.worker_id,
          issuedAtMs: invitation.issued_at_ms,
          expiresAtMs: invitation.expires_at_ms,
        };
      }
    }
    return {
      taskId: task.id,
      idempotencyKey: task.idempotency_key,
      target: {
        type: task.target_type as TargetRef["type"],
        id: task.target_id,
      },
      serviceTimeMs: task.service_time_ms,
      status: task.status as TaskView["status"],
      currentInvitation,
      acceptedWorkerId,
    };
  }

  private findTaskByKey(idempotencyKey: string): TaskRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE idempotency_key = ?`)
      .get(idempotencyKey) as unknown as TaskRow | undefined;
    return row ?? null;
  }

  private findTaskRow(taskId: number): TaskRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) as unknown as TaskRow | undefined;
    return row ?? null;
  }

  private getTaskRow(taskId: number): TaskRow {
    const row = this.findTaskRow(taskId);
    if (row === null) {
      throw new Error(`task ${taskId} not found`);
    }
    return row;
  }

  private getInvitationRow(invitationId: number): InvitationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM invitations WHERE id = ?`)
      .get(invitationId) as unknown as InvitationRow | undefined;
    return row ?? null;
  }

  private inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
