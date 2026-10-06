import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { ExecResult, HistoryEntry, Instruction, Site, VmPowerState } from './types';

export type VmStateMap = Record<string, Record<Site, VmPowerState>>;

interface PendingCall {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
}

// Parent-side handle for a forked executor process.
export class ExecutorClient {
  private child: ChildProcess | null = null;
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(readonly dbPath: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = fork(path.join(__dirname, 'executor-process.js'), [this.dbPath], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    child.on('message', (raw: { kind: string; seq?: number } & Record<string, unknown>) => {
      if (raw.kind === 'ready') return;
      const seq = raw.seq;
      if (seq === undefined) return;
      const call = this.pending.get(seq);
      if (!call) return;
      this.pending.delete(seq);
      if (raw.kind === 'error') {
        call.reject(new Error(String(raw.message)));
      } else {
        call.resolve(raw as never);
      }
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      const err = new Error(
        `executor process exited (code=${code}, signal=${signal}); in-flight instruction results are unknown and must be recovered by replay`,
      );
      for (const call of this.pending.values()) call.reject(err);
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      const onMessage = (raw: { kind?: string }): void => {
        if (raw.kind === 'ready') {
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
      child.once('exit', () => reject(new Error('executor exited before ready')));
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  private call<T>(message: Record<string, unknown>): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('executor not running'));
    const seq = this.nextSeq++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, {
        resolve: resolve as (value: never) => void,
        reject,
      });
      child.send({ ...message, seq });
    });
  }

  async exec(instruction: Instruction): Promise<ExecResult> {
    const reply = await this.call<{ result: ExecResult }>({
      kind: 'exec',
      instructionId: instruction.instructionId,
      vmId: instruction.vmId,
      site: instruction.site,
      op: instruction.op,
    });
    return reply.result;
  }

  async initVms(vmIds: string[]): Promise<void> {
    await this.call({ kind: 'initVms', vmIds });
  }

  async queryStates(): Promise<VmStateMap> {
    const reply = await this.call<{ states: VmStateMap }>({ kind: 'queryStates' });
    return reply.states;
  }

  async queryHistory(): Promise<HistoryEntry[]> {
    const reply = await this.call<{ entries: HistoryEntry[] }>({ kind: 'queryHistory' });
    return reply.entries;
  }
}
