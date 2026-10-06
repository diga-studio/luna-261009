/** 站点标识：A / B 两站。 */
export type Site = "A" | "B";
/** 副本运行状态。 */
export type ReplicaState = "running" | "stopped";
/** 单台副本上的指令操作。 */
export type VmOp = "start" | "stop";
/** 指令执行结果：成功或永久拒绝。 */
export type CommandOutcome = "ok" | "rejected";
/** 请求终态。 */
export type RequestOutcome = "success" | "failure";
/** 请求处理阶段（编排状态机）。 */
export type RequestPhase = "STOP_SOURCE" | "START_TARGET" | "STOP_TARGET" | "START_SOURCE" | "DONE";
/** 父进程 -> 执行器 的消息。 */
export type ExecutorRequest = {
    type: "register";
    vmId: string;
    site: Site;
    state: ReplicaState;
} | {
    type: "exec";
    commandId: string;
    vmId: string;
    site: Site;
    op: VmOp;
} | {
    type: "query";
} | {
    type: "armReject";
    commandId: string;
} | {
    type: "pauseAt";
    point: "beforeApply" | "beforeReply";
    commandId: string;
} | {
    type: "resume";
} | {
    type: "history";
} | {
    type: "shutdown";
};
/** 执行器 -> 父进程 的消息。 */
export type ExecutorResponse = {
    type: "registered";
    vmId: string;
    site: Site;
} | {
    type: "result";
    commandId: string;
    outcome: CommandOutcome;
} | {
    type: "state";
    replicas: Array<{
        vmId: string;
        site: Site;
        state: ReplicaState;
    }>;
} | {
    type: "history";
    entries: Array<{
        seq: number;
        commandId: string;
        vmId: string;
        site: Site;
        op: VmOp;
        outcome: CommandOutcome;
        applied: number;
    }>;
} | {
    type: "paused";
    point: string;
    commandId: string;
} | {
    type: "ready";
};
/** Inspect 的返回结构。 */
export interface GroupInspection {
    groupId: string;
    activeSite: Site;
    request: {
        requestId: string;
        fromSite: Site;
        toSite: Site;
        phase: RequestPhase;
        outcome: RequestOutcome | null;
    } | null;
    members: Array<{
        vmId: string;
        a: ReplicaState;
        b: ReplicaState;
    }>;
}
