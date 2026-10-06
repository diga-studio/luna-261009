/**
 * 编排进程侧的执行器客户端：负责 fork 执行器子进程、
 * 发送指令并等待结果、查询副本状态与执行历史。
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  CommandOutcome,
  ExecutorRequest,
  ExecutorResponse,
  ReplicaState,
  Site,
  VmOp,
} from "./types.js";

export interface ExecutorClientOptions {
  dbPath: string;
  /** 测试用：指定编译后的 executor.js 路径。 */
  executorPath?: string;
}

export interface HistoryEntry {
  seq: number;
  commandId: string;
  vmId: string;
  site: Site;
  op: VmOp;
  outcome: CommandOutcome;
  applied: number;
}

const defaultExecutorPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "executor.js",
);

export class ExecutorClient {
  private child: ChildProcess | null = null;
  private pending = new Map<
    string,
    { resolve: (msg: ExecutorResponse) => void; reject: (err: Error) => void }
  >();
  private waiters: Array<{
    match: (msg: ExecutorResponse) => boolean;
    resolve: (msg: ExecutorResponse) => void;
  }> = [];
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly options: ExecutorClientOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    const execPath = this.options.executorPath ?? defaultExecutorPath;
    const child = fork(execPath, [this.options.dbPath], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    child.on("message", (msg: ExecutorResponse) => this.dispatch(msg));
    child.on("exit", () => {
      this.child = null;
      const err = new Error("executor process exited");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.readyPromise = new Promise<void>((resolve) => {
      this.waiters.push({
        match: (m) => m.type === "ready",
        resolve: () => resolve(),
      });
    });
    await this.readyPromise;
  }

  private dispatch(msg: ExecutorResponse): void {
    if (msg.type === "result") {
      const p = this.pending.get(msg.commandId);
      if (p) {
        this.pending.delete(msg.commandId);
        p.resolve(msg);
        return;
      }
    }
    if (msg.type === "registered") {
      const key = `registered:${msg.vmId}:${msg.site}`;
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        p.resolve(msg);
        return;
      }
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.match(msg)) {
        this.waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
  }

  private send(msg: ExecutorRequest): void {
    if (!this.child) throw new Error("executor not running");
    this.child.send(msg);
  }

  private request<T extends ExecutorResponse>(
    msg: ExecutorRequest & { type: string },
    key: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, {
        resolve: (m) => resolve(m as T),
        reject,
      });
      this.send(msg);
    });
  }

  /** 等待执行器进入暂停点（测试用）。 */
  waitPaused(commandId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push({
        match: (m) => m.type === "paused" && m.commandId === commandId,
        resolve: () => resolve(),
      });
    });
  }

  async register(vmId: string, site: Site, state: ReplicaState): Promise<void> {
    await this.request(
      { type: "register", vmId, site, state },
      `registered:${vmId}:${site}`,
    );
  }

  async exec(
    commandId: string,
    vmId: string,
    site: Site,
    op: VmOp,
  ): Promise<CommandOutcome> {
    const res = await this.request<Extract<ExecutorResponse, { type: "result" }>>(
      { type: "exec", commandId, vmId, site, op },
      commandId,
    );
    return res.outcome;
  }

  async queryState(): Promise<
    Array<{ vmId: string; site: Site; state: ReplicaState }>
  > {
    const res = await new Promise<
      Extract<ExecutorResponse, { type: "state" }>
    >((resolve) => {
      this.waiters.push({
        match: (m) => m.type === "state",
        resolve: (m) => resolve(m as Extract<ExecutorResponse, { type: "state" }>),
      });
      this.send({ type: "query" });
    });
    return res.replicas;
  }

  async history(): Promise<HistoryEntry[]> {
    const res = await new Promise<
      Extract<ExecutorResponse, { type: "history" }>
    >((resolve) => {
      this.waiters.push({
        match: (m) => m.type === "history",
        resolve: (m) =>
          resolve(m as Extract<ExecutorResponse, { type: "history" }>),
      });
      this.send({ type: "history" });
    });
    return res.entries;
  }

  async armReject(commandId: string): Promise<void> {
    this.send({ type: "armReject", commandId });
    // armReject 需落盘后才安全；用一次 query 往返做屏障。
    await this.queryState();
  }

  async pauseAt(
    point: "beforeApply" | "beforeReply",
    commandId: string,
  ): Promise<void> {
    this.send({ type: "pauseAt", point, commandId });
    await this.queryState();
  }

  async resume(): Promise<void> {
    this.send({ type: "resume" });
  }

  /** 强杀执行器子进程（测试用）。 */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill("SIGKILL");
    await exited;
    this.child = null;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      child.send({ type: "shutdown" } satisfies ExecutorRequest);
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
    this.child = null;
  }
}
