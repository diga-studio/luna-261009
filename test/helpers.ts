import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryEntry, Site, VmPowerState } from '../src/types';

export interface TestEnv {
  dir: string;
  orchDb: string;
  execDb: string;
  pauseFlag: string;
}

export function makeEnv(testName: string): TestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `switchover-${testName}-`));
  return {
    dir,
    orchDb: path.join(dir, 'orchestrator.db'),
    execDb: path.join(dir, 'executor.db'),
    pauseFlag: path.join(dir, 'executor.db.paused'),
  };
}

export function cleanupEnv(env: TestEnv): void {
  fs.rmSync(env.dir, { recursive: true, force: true });
}

// ---- executor database control (test injects faults directly) ------------

const CONTROL_SCHEMA = `
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

export function addPauseRule(
  execDb: string,
  point: 'beforeApply' | 'afterPersist',
  match: { vmId?: string; site?: Site; op?: 'start' | 'stop' },
): void {
  const db = new DatabaseSync(execDb);
  try {
    db.exec(CONTROL_SCHEMA);
    db.prepare('INSERT INTO pause_rules (point, vm_id, site, op) VALUES (?, ?, ?, ?)').run(
      point,
      match.vmId ?? null,
      match.site ?? null,
      match.op ?? null,
    );
  } finally {
    db.close();
  }
}

export function addRejectRule(execDb: string, vmId: string, site: Site): void {
  const db = new DatabaseSync(execDb);
  try {
    db.exec(CONTROL_SCHEMA);
    db.prepare('INSERT OR IGNORE INTO reject_rules (vm_id, site) VALUES (?, ?)').run(
      vmId,
      site,
    );
  } finally {
    db.close();
  }
}

export function readHistory(execDb: string): HistoryEntry[] {
  const db = new DatabaseSync(execDb);
  try {
    const rows = db
      .prepare('SELECT seq, instruction_id, vm_id, site, op, event FROM history ORDER BY seq')
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      instructionId: r.instruction_id as string,
      vmId: r.vm_id as string,
      site: r.site as Site,
      op: r.op as 'start' | 'stop',
      event: r.event as HistoryEntry['event'],
    }));
  } finally {
    db.close();
  }
}

export function readStates(execDb: string): Record<string, Record<Site, VmPowerState>> {
  const db = new DatabaseSync(execDb);
  try {
    const rows = db
      .prepare('SELECT vm_id, site, state FROM vm_state')
      .all() as unknown as Array<Record<string, unknown>>;
    const out: Record<string, Record<Site, VmPowerState>> = {};
    for (const r of rows) {
      const vmId = r.vm_id as string;
      out[vmId] = out[vmId] ?? ({} as Record<Site, VmPowerState>);
      out[vmId][r.site as Site] = r.state as VmPowerState;
    }
    return out;
  } finally {
    db.close();
  }
}

// ---- process control ------------------------------------------------------

export interface RunnerHandle {
  child: ChildProcess;
  executorPid: Promise<number>;
  resultLine: Promise<unknown>;
  exited: Promise<void>;
  stdout: string[];
}

export function spawnRunner(args: string[]): RunnerHandle {
  const runnerPath = path.join(__dirname, '..', 'src', 'switch-runner.js');
  const child = spawn(process.execPath, [runnerPath, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stdout: string[] = [];
  let executorPidResolve: (pid: number) => void;
  let resultResolve: (value: unknown) => void;
  const executorPid = new Promise<number>((resolve) => {
    executorPidResolve = resolve;
  });
  const resultLine = new Promise<unknown>((resolve) => {
    resultResolve = resolve;
  });
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      stdout.push(line);
      if (line.startsWith('EXECUTOR_PID:')) {
        executorPidResolve(Number(line.slice('EXECUTOR_PID:'.length)));
      } else if (line.startsWith('RESULT:')) {
        resultResolve(JSON.parse(line.slice('RESULT:'.length)));
      } else if (line.startsWith('RESULTS:')) {
        resultResolve(JSON.parse(line.slice('RESULTS:'.length)));
      }
    }
  });
  return { child, executorPid, resultLine, exited, stdout };
}

export async function waitForFile(file: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

export async function killAndWait(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} did not die`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Kills the runner and its executor, waiting for both to be gone.
export async function killRunnerAndExecutor(handle: RunnerHandle): Promise<void> {
  const executorPid = await handle.executorPid;
  const childPid = handle.child.pid!;
  await Promise.all([killAndWait(childPid), killAndWait(executorPid)]);
  await handle.exited;
}

// ---- history assertions ----------------------------------------------------

export function applied(history: HistoryEntry[]): HistoryEntry[] {
  return history.filter((e) => e.event === 'applied');
}

// Every instruction may be applied at most once; replays must not re-apply.
export function assertAppliedOnce(history: HistoryEntry[]): void {
  const counts = new Map<string, number>();
  for (const e of applied(history)) {
    counts.set(e.instructionId, (counts.get(e.instructionId) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count !== 1) {
      throw new Error(`instruction ${id} applied ${count} times`);
    }
  }
}

// Group-level ordering: every application matching `before` must precede every
// application matching `after`.
export function assertAppliedBefore(
  history: HistoryEntry[],
  before: (e: HistoryEntry) => boolean,
  after: (e: HistoryEntry) => boolean,
  message: string,
): void {
  const apps = applied(history);
  const beforeSeqs = apps.filter(before).map((e) => e.seq);
  const afterSeqs = apps.filter(after).map((e) => e.seq);
  if (beforeSeqs.length === 0 || afterSeqs.length === 0) {
    throw new Error(`missing applied events for ordering check: ${message}`);
  }
  if (Math.max(...beforeSeqs) > Math.min(...afterSeqs)) {
    throw new Error(`ordering violated: ${message}`);
  }
}
