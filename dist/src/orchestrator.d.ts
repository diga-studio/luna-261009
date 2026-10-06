import type { ExecutorClient } from "./executorClient.js";
import type { GroupInspection, RequestOutcome, Site } from "./types.js";
export interface OrchestratorOptions {
    /** 编排数据库文件路径。 */
    dbPath: string;
    /** 执行器客户端（由调用方创建并 start）。 */
    executor: ExecutorClient;
}
export interface SwitchResult {
    outcome: RequestOutcome;
    /** 本次切换后的活动站点（失败时保持原站点）。 */
    activeSite: Site;
}
export declare class Orchestrator {
    private readonly db;
    private readonly executor;
    constructor(options: OrchestratorOptions);
    /** 建立保护组初始状态：A 端全部运行、B 端全部停止。 */
    createGroup(groupId: string, vmIds: string[]): Promise<void>;
    /**
     * 计划切换 / 故障回切到另一站。
     * 同 requestId 重放：继续原请求或返回其原有终态，不再次切换。
     */
    switchGroup(groupId: string, requestId: string): Promise<SwitchResult>;
    /** 继续所有未完成请求，直到全部收敛到终态。 */
    recover(): Promise<void>;
    /** 读取活动站点、请求状态和成员两端实际状态。 */
    inspect(groupId: string): Promise<GroupInspection>;
    close(): void;
    private getGroup;
    private getRequest;
    /** 在单个事务中写入请求及其全部四个阶段的确定性指令计划。 */
    private createRequestPlan;
    /**
     * 驱动状态机直到请求到达终态。
     * 每次只等待一条执行器指令，等待期间不持有任何事务。
     */
    private drive;
    /** 当前阶段指令全部完成后推进状态机（单事务）。 */
    private advancePhase;
}
