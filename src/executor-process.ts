// Executor child-process entry point. Owns the executor SQLite database and is
// the only writer of VM power states. Communicates with the parent over IPC.
//
// Persistence is fully independent from the orchestrator database. Every VM
// state change and its instruction-status transition are committed in a single
// executor-local transaction, so an instruction row left in 'received' state
// always means "no side effect happened yet".
//
// Test control is data-driven through the executor database itself:
//   - reject_rules(vm_id, site): matching start operations are permanently
//     rejected (result persisted, no side effect).
//   - pause_rules(point, vm_id, site, op): the first matching instruction
//     consumes the rule, writes a `<dbPath>.paused` flag file and then blocks
//     forever, giving tests a precise kill point. point is 'beforeApply'
//     (before the state change) or 'afterPersist' (state change committed,
//     reply not yet sent).

import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vm_state (
  vm_id TEXT NOT NULL,
  site  TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (vm_id, site)
);
CREATE TABLE IF NOT EXISTS instructions (
  instruction_id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL,
  site  TEXT NOT NULL,
  op    TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  instruction_id TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  site TEXT NOT NULL,
  op   TEXT NOT NULL,
  event TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reject_rules (
  vm_id TEXT NOT NULL,
  site TEXT NOT NULL,
  PRIMARY KEY (vm_id, site)
);
CREATE TABLE IF NOT EXISTS pause_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point TEXT NOT NULL,
  vm_id TEXT,
  site TEXT,
  op   TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);
`;

interface ExecMessage {
  kind: 'exec';
  seq: number;
  instructionId: string;
  vmId: string;
  site: string;
  op: 'start' | 'stop';
}

interface InitVmsMessage {
  kind: 'initVms';
  seq: number;
  vmIds: string[];
}

interface QueryMessage {
  kind: 'queryStates' | 'queryHistory';
  seq: number;
}

type Incoming = ExecMessage | InitVmsMessage | QueryMessage;

export function runExecutorProcess(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(SCHEMA);

  const send = (msg: unknown): void => {
    if (typeof process.send === 'function' && process.connected) {
      process.send(msg);
    }
  };

  const recordHistory = (
    instructionId: string,
    vmId: string,
    site: string,
    op: string,
    event: string,
  ): void => {
    db.prepare(
      'INSERT INTO history (instruction_id, vm_id, site, op, event) VALUES (?, ?, ?, ?, ?)',
    ).run(instructionId, vmId, site, op, event);
  };

  // Blocks forever after consuming a matching pause rule; the test kills the
  // process at this exact point.
  const maybePause = (point: string, vmId: string, site: string, op: string): void => {
    const rule = db
      .prepare(
        `SELECT id FROM pause_rules
         WHERE point = ? AND consumed = 0
           AND (vm_id IS NULL OR vm_id = ?)
           AND (site IS NULL OR site = ?)
           AND (op IS NULL OR op = ?)
         ORDER BY id LIMIT 1`,
      )
      .get(point, vmId, site, op) as Row | undefined;
    if (!rule) return;
    db.prepare('UPDATE pause_rules SET consumed = 1 WHERE id = ?').run(rule.id as number);
    fs.writeFileSync(
      `${dbPath}.paused`,
      JSON.stringify({ point, vmId, site, op, pid: process.pid }),
    );
    // Never return: block the event loop until the process is killed.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };

  const handleExec = (msg: ExecMessage): void => {
    const { instructionId, vmId, site, op } = msg;

    const existing = db
      .prepare('SELECT status FROM instructions WHERE instruction_id = ?')
      .get(instructionId) as Row | undefined;

    if (existing && (existing.status === 'applied' || existing.status === 'rejected')) {
      // Idempotent replay: return the persisted result, never re-apply.
      recordHistory(instructionId, vmId, site, op, 'replayed');
      send({
        kind: 'result',
        seq: msg.seq,
        instructionId,
        result: existing.status === 'applied' ? 'success' : 'rejected',
      });
      return;
    }

    if (!existing) {
      db.exec('BEGIN');
      try {
        db.prepare(
          'INSERT INTO instructions (instruction_id, vm_id, site, op, status) VALUES (?, ?, ?, ?, ?)',
        ).run(instructionId, vmId, site, op, 'received');
        recordHistory(instructionId, vmId, site, op, 'received');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    // Permanent rejection: only start operations can be rejected, and the
    // rejection has no side effect on VM state.
    if (op === 'start') {
      const reject = db
        .prepare('SELECT 1 FROM reject_rules WHERE vm_id = ? AND site = ?')
        .get(vmId, site) as Row | undefined;
      if (reject) {
        db.exec('BEGIN');
        try {
          db.prepare(
            "UPDATE instructions SET status = 'rejected' WHERE instruction_id = ?",
          ).run(instructionId);
          recordHistory(instructionId, vmId, site, op, 'rejected');
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        send({ kind: 'result', seq: msg.seq, instructionId, result: 'rejected' });
        return;
      }
    }

    maybePause('beforeApply', vmId, site, op);

    // Apply the state change and mark the instruction applied atomically.
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE vm_state SET state = ? WHERE vm_id = ? AND site = ?').run(
        op === 'start' ? 'running' : 'stopped',
        vmId,
        site,
      );
      db.prepare(
        "UPDATE instructions SET status = 'applied' WHERE instruction_id = ?",
      ).run(instructionId);
      recordHistory(instructionId, vmId, site, op, 'applied');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    maybePause('afterPersist', vmId, site, op);

    send({ kind: 'result', seq: msg.seq, instructionId, result: 'success' });
  };

  const handleInitVms = (msg: InitVmsMessage): void => {
    db.exec('BEGIN');
    try {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO vm_state (vm_id, site, state) VALUES (?, ?, ?)',
      );
      for (const vmId of msg.vmIds) {
        insert.run(vmId, 'A', 'running');
        insert.run(vmId, 'B', 'stopped');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    send({ kind: 'ok', seq: msg.seq });
  };

  const handleQuery = (msg: QueryMessage): void => {
    if (msg.kind === 'queryStates') {
      const rows = db
        .prepare('SELECT vm_id, site, state FROM vm_state ORDER BY vm_id, site')
        .all() as Row[];
      const states: Record<string, Record<string, string>> = {};
      for (const row of rows) {
        const vmId = row.vm_id as string;
        states[vmId] = states[vmId] ?? {};
        states[vmId][row.site as string] = row.state as string;
      }
      send({ kind: 'states', seq: msg.seq, states });
    } else {
      const entries = db
        .prepare(
          'SELECT seq, instruction_id, vm_id, site, op, event FROM history ORDER BY seq',
        )
        .all() as Row[];
      send({
        kind: 'history',
        seq: msg.seq,
        entries: entries.map((e) => ({
          seq: e.seq,
          instructionId: e.instruction_id,
          vmId: e.vm_id,
          site: e.site,
          op: e.op,
          event: e.event,
        })),
      });
    }
  };

  process.on('message', (raw: Incoming) => {
    try {
      if (raw.kind === 'exec') handleExec(raw);
      else if (raw.kind === 'initVms') handleInitVms(raw);
      else handleQuery(raw);
    } catch (err) {
      send({ kind: 'error', seq: raw.seq, message: String(err) });
    }
  });

  // Die together with the parent so no orphaned executor keeps the database.
  process.on('disconnect', () => process.exit(0));

  send({ kind: 'ready', pid: process.pid });
}

if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    throw new Error('usage: executor-process <dbPath>');
  }
  runExecutorProcess(dbPath);
}
