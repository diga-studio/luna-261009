import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db';
import type { ExecutorClient } from './executor-client';
import type {
  ExecResult,
  InspectResult,
  RequestInfo,
  RequestPhase,
  Site,
  SwitchResult,
  VmInspection,
} from './types';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  active_site TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_vms (
  group_id TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  PRIMARY KEY (group_id, vm_id)
);
CREATE TABLE IF NOT EXISTS requests (
  group_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  from_site TEXT NOT NULL,
  to_site TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (group_id, request_id)
);
CREATE TABLE IF NOT EXISTS instructions (
  group_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  site TEXT NOT NULL,
  op TEXT NOT NULL,
  instruction_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  PRIMARY KEY (group_id, request_id, phase, vm_id)
);
`;

interface RequestRow {
  groupId: string;
  requestId: string;
  fromSite: Site;
  toSite: Site;
  phase: RequestPhase;
  status: 'in_progress' | 'success' | 'failed';
  reason: string | null;
}

interface InstructionRow {
  vmId: string;
  site: Site;
  op: 'start' | 'stop';
  instructionId: string;
  status: 'pending' | 'sent' | 'success' | 'rejected';
}

const PHASE_INSTRUCTIONS: Record<
  RequestPhase,
  (req: RequestRow) => { site: Site; op: 'start' | 'stop' }
> = {
  stopping_source: (req) => ({ site: req.fromSite, op: 'stop' }),
  starting_target: (req) => ({ site: req.toSite, op: 'start' }),
  stopping_target: (req) => ({ site: req.toSite, op: 'stop' }),
  starting_source: (req) => ({ site: req.fromSite, op: 'start' }),
};

export class Orchestrator {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly executor: ExecutorClient,
  ) {
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);
  }

  async createGroup(groupId: string, vmIds: string[]): Promise<void> {
    if (vmIds.length < 1 || vmIds.length > 50) {
      throw new Error(`group must contain 1..50 VMs, got ${vmIds.length}`);
    }
    if (new Set(vmIds).size !== vmIds.length) {
      throw new Error('duplicate vm ids');
    }
    const existing = this.db
      .prepare('SELECT 1 FROM groups WHERE group_id = ?')
      .get(groupId) as Row | undefined;
    if (existing) throw new Error(`group ${groupId} already exists`);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO groups (group_id, active_site) VALUES (?, ?)')
        .run(groupId, 'A');
      const insertVm = this.db.prepare(
        'INSERT INTO group_vms (group_id, vm_id) VALUES (?, ?)',
      );
      for (const vmId of vmIds) insertVm.run(groupId, vmId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Executor state lives in its own database; initVms is idempotent.
    await this.executor.initVms(vmIds);
  }

  async switchGroup(groupId: string, requestId: string): Promise<SwitchResult> {
    const group = this.db
      .prepare('SELECT active_site FROM groups WHERE group_id = ?')
      .get(groupId) as Row | undefined;
    if (!group) throw new Error(`unknown group ${groupId}`);

    const existing = this.loadRequest(groupId, requestId);
    if (existing) {
      if (existing.status !== 'in_progress') {
        // Idempotent replay of a finished request: return the recorded
        // terminal result without touching anything.
        return this.toResult(existing);
      }
      return this.drive(existing);
    }

    const active = this.db
      .prepare(
        "SELECT request_id FROM requests WHERE group_id = ? AND status = 'in_progress'",
      )
      .get(groupId) as Row | undefined;
    if (active) {
      throw new Error(
        `group ${groupId} already has an unfinished request ${active.request_id}`,
      );
    }

    const fromSite = group.active_site as Site;
    const toSite: Site = fromSite === 'A' ? 'B' : 'A';
    this.db
      .prepare(
        `INSERT INTO requests (group_id, request_id, from_site, to_site, phase, status)
         VALUES (?, ?, ?, ?, 'stopping_source', 'in_progress')`,
      )
      .run(groupId, requestId, fromSite, toSite);
    const request = this.loadRequest(groupId, requestId);
    if (!request) throw new Error('internal: request not persisted');
    return this.drive(request);
  }

  async recover(): Promise<SwitchResult[]> {
    const rows = this.db
      .prepare(
        "SELECT group_id, request_id FROM requests WHERE status = 'in_progress' ORDER BY rowid",
      )
      .all() as Row[];
    const results: SwitchResult[] = [];
    for (const row of rows) {
      const request = this.loadRequest(row.group_id as string, row.request_id as string);
      if (request) results.push(await this.drive(request));
    }
    return results;
  }

  async inspect(groupId: string): Promise<InspectResult> {
    const group = this.db
      .prepare('SELECT active_site FROM groups WHERE group_id = ?')
      .get(groupId) as Row | undefined;
    if (!group) throw new Error(`unknown group ${groupId}`);

    const latest = this.db
      .prepare(
        `SELECT request_id, status, phase, from_site, to_site FROM requests
         WHERE group_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(groupId) as Row | undefined;

    const vmIds = (
      this.db
        .prepare('SELECT vm_id FROM group_vms WHERE group_id = ? ORDER BY vm_id')
        .all(groupId) as Row[]
    ).map((r) => r.vm_id as string);

    const states = await this.executor.queryStates();
    const vms: VmInspection[] = vmIds.map((vmId) => ({
      vmId,
      A: states[vmId]?.A ?? 'stopped',
      B: states[vmId]?.B ?? 'stopped',
    }));

    return {
      groupId,
      activeSite: group.active_site as Site,
      request: latest
        ? {
            requestId: latest.request_id as string,
            status: latest.status as RequestInfo['status'],
            phase: latest.phase as RequestPhase,
            fromSite: latest.from_site as Site,
            toSite: latest.to_site as Site,
          }
        : null,
      vms,
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- internals -------------------------------------------------------

  private loadRequest(groupId: string, requestId: string): RequestRow | null {
    const row = this.db
      .prepare(
        `SELECT group_id, request_id, from_site, to_site, phase, status, reason
         FROM requests WHERE group_id = ? AND request_id = ?`,
      )
      .get(groupId, requestId) as Row | undefined;
    if (!row) return null;
    return {
      groupId: row.group_id as string,
      requestId: row.request_id as string,
      fromSite: row.from_site as Site,
      toSite: row.to_site as Site,
      phase: row.phase as RequestPhase,
      status: row.status as RequestRow['status'],
      reason: (row.reason as string | null) ?? null,
    };
  }

  private toResult(request: RequestRow): SwitchResult {
    const group = this.db
      .prepare('SELECT active_site FROM groups WHERE group_id = ?')
      .get(request.groupId) as Row;
    return {
      requestId: request.requestId,
      status: request.status === 'success' ? 'success' : 'failed',
      activeSite: group.active_site as Site,
      reason: request.reason ?? undefined,
    };
  }

  private ensurePhaseInstructions(request: RequestRow): void {
    const { site, op } = PHASE_INSTRUCTIONS[request.phase](request);
    const vmIds = (
      this.db
        .prepare('SELECT vm_id FROM group_vms WHERE group_id = ? ORDER BY vm_id')
        .all(request.groupId) as Row[]
    ).map((r) => r.vm_id as string);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO instructions
         (group_id, request_id, phase, vm_id, site, op, instruction_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    this.db.exec('BEGIN');
    try {
      for (const vmId of vmIds) {
        insert.run(
          request.groupId,
          request.requestId,
          request.phase,
          vmId,
          site,
          op,
          `${request.groupId}/${request.requestId}/${request.phase}/${vmId}`,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private loadPhaseInstructions(request: RequestRow): InstructionRow[] {
    const rows = this.db
      .prepare(
        `SELECT vm_id, site, op, instruction_id, status FROM instructions
         WHERE group_id = ? AND request_id = ? AND phase = ? ORDER BY vm_id`,
      )
      .all(request.groupId, request.requestId, request.phase) as Row[];
    return rows.map((r) => ({
      vmId: r.vm_id as string,
      site: r.site as Site,
      op: r.op as 'start' | 'stop',
      instructionId: r.instruction_id as string,
      status: r.status as InstructionRow['status'],
    }));
  }

  // Executes one instruction against the executor. The orchestrator database
  // is never locked by an open transaction while waiting for the reply: the
  // 'sent' marker is committed before the call, the result after.
  private async runInstruction(inst: InstructionRow): Promise<ExecResult> {
    if (inst.status === 'success' || inst.status === 'rejected') return inst.status;
    if (inst.status === 'pending') {
      this.db
        .prepare("UPDATE instructions SET status = 'sent' WHERE instruction_id = ?")
        .run(inst.instructionId);
    }
    const result = await this.executor.exec({
      instructionId: inst.instructionId,
      vmId: inst.vmId,
      site: inst.site,
      op: inst.op,
    });
    this.db
      .prepare('UPDATE instructions SET status = ? WHERE instruction_id = ?')
      .run(result, inst.instructionId);
    return result;
  }

  private setPhase(request: RequestRow, phase: RequestPhase): void {
    this.db
      .prepare('UPDATE requests SET phase = ? WHERE group_id = ? AND request_id = ?')
      .run(phase, request.groupId, request.requestId);
    request.phase = phase;
  }

  private finalizeSuccess(request: RequestRow): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          "UPDATE requests SET status = 'success' WHERE group_id = ? AND request_id = ?",
        )
        .run(request.groupId, request.requestId);
      this.db
        .prepare('UPDATE groups SET active_site = ? WHERE group_id = ?')
        .run(request.toSite, request.groupId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    request.status = 'success';
  }

  private finalizeFailure(request: RequestRow, reason: string): void {
    this.db
      .prepare(
        "UPDATE requests SET status = 'failed', reason = ? WHERE group_id = ? AND request_id = ?",
      )
      .run(reason, request.groupId, request.requestId);
    request.status = 'failed';
    request.reason = reason;
  }

  // Drives the request state machine until it reaches a terminal state.
  // Resumable from any persisted point; safe to re-enter after a crash.
  private async drive(request: RequestRow): Promise<SwitchResult> {
    for (;;) {
      this.ensurePhaseInstructions(request);
      const instructions = this.loadPhaseInstructions(request);
      let rejectedVm: string | null = null;
      for (const inst of instructions) {
        const result = await this.runInstruction(inst);
        if (result === 'rejected') {
          rejectedVm = inst.vmId;
          break;
        }
      }

      if (rejectedVm !== null) {
        if (request.phase !== 'starting_target') {
          throw new Error(`unexpected rejection in phase ${request.phase}`);
        }
        // Target-side start permanently rejected: roll back. Stop every
        // target replica first, then restart the whole source side, and only
        // then record the failure. The active site never flips.
        const reason = `start permanently rejected for vm ${rejectedVm} on site ${request.toSite}`;
        this.db
          .prepare(
            'UPDATE requests SET reason = ? WHERE group_id = ? AND request_id = ?',
          )
          .run(reason, request.groupId, request.requestId);
        request.reason = reason;
        this.setPhase(request, 'stopping_target');
        continue;
      }

      switch (request.phase) {
        case 'stopping_source':
          this.setPhase(request, 'starting_target');
          break;
        case 'starting_target':
          this.finalizeSuccess(request);
          return this.toResult(request);
        case 'stopping_target':
          this.setPhase(request, 'starting_source');
          break;
        case 'starting_source':
          this.finalizeFailure(
            request,
            request.reason ?? 'rolled back after target-side rejection',
          );
          return this.toResult(request);
      }
    }
  }
}
