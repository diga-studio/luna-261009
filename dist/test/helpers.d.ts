/** 测试辅助：临时目录、执行器库直读、故障注入、可杀子进程。 */
import { DatabaseSync } from "node:sqlite";
import { ExecutorClient, type HistoryEntry } from "../src/executorClient.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ReplicaState, Site } from "../src/types.js";
export interface TestEnv {
    dir: string;
    orchDb: string;
    execDb: string;
    executor: ExecutorClient;
    orchestrator: Orchestrator;
    cleanup: () => Promise<void>;
}
export declare function setupEnv(): Promise<TestEnv>;
/** 直接打开执行器库做故障注入 / 核验（执行器历史必须可检查）。 */
export declare function withExecDb<T>(execDb: string, fn: (db: DatabaseSync) => T): T;
export declare function armPause(execDb: string, commandId: string, point: "beforeApply" | "beforeReply"): void;
export declare function armReject(execDb: string, commandId: string): void;
/** 轮询直到暂停点被命中（暂停是一次性的，命中即删除记录）。 */
export declare function waitPauseHit(execDb: string, commandId: string, point: string, timeoutMs?: number): Promise<void>;
export declare function readHistory(execDb: string): HistoryEntry[];
export declare function readReplicas(execDb: string): Array<{
    vmId: string;
    site: Site;
    state: ReplicaState;
}>;
export interface WorkerHandle {
    pid: number;
    done: Promise<number>;
    /** 强杀 worker 及其 executor 子进程（同一进程组）。 */
    kill: () => void;
}
export declare function runSwitchWorker(orchDb: string, execDb: string, groupId: string, requestId: string): WorkerHandle;
export declare function runRecoverWorker(orchDb: string, execDb: string): WorkerHandle;
/** 指令 ID 与编排库派生规则一致，仅供测试计算暂停/拒绝目标。 */
export declare function cmdId(groupId: string, requestId: string, seq: number): string;
