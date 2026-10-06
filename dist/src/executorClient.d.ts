import type { CommandOutcome, ReplicaState, Site, VmOp } from "./types.js";
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
export declare class ExecutorClient {
    private readonly options;
    private child;
    private pending;
    private waiters;
    private readyPromise;
    constructor(options: ExecutorClientOptions);
    start(): Promise<void>;
    private dispatch;
    private send;
    private request;
    /** 等待执行器进入暂停点（测试用）。 */
    waitPaused(commandId: string): Promise<void>;
    register(vmId: string, site: Site, state: ReplicaState): Promise<void>;
    exec(commandId: string, vmId: string, site: Site, op: VmOp): Promise<CommandOutcome>;
    queryState(): Promise<Array<{
        vmId: string;
        site: Site;
        state: ReplicaState;
    }>>;
    history(): Promise<HistoryEntry[]>;
    armReject(commandId: string): Promise<void>;
    pauseAt(point: "beforeApply" | "beforeReply", commandId: string): Promise<void>;
    resume(): Promise<void>;
    /** 强杀执行器子进程（测试用）。 */
    kill(): Promise<void>;
    shutdown(): Promise<void>;
}
