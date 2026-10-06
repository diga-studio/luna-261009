import type { Identity, Policy, Principal } from './types.js';
/** 某时刻某身份在某环境/资源类型上的策略判定结果 */
export interface PolicyDecision {
    /** 是否允许访问（无匹配 allow 或存在生效 deny 时为 false） */
    allowed: boolean;
    /** 选定的最长会话时长（毫秒）；不允许时为 null */
    maxSessionMs: number | null;
    /** 选定的同级 allow 中是否有任意一条要求审批 */
    requiresApproval: boolean;
}
/** 窗口已解析为当日毫秒的策略，供热路径复用 */
export interface CompiledPolicy {
    principal: Principal;
    environmentId: string;
    resourceType: string;
    effect: 'allow' | 'deny';
    priority: number;
    windowStartMs: number;
    windowEndMs: number;
    maxSessionMs: number;
    requiresApproval: boolean;
}
export declare function compilePolicy(policy: Policy): CompiledPolicy;
export declare function principalMatches(principal: Principal, identity: Identity): boolean;
/**
 * 基于预编译策略计算某 UTC 毫秒时刻的判定。
 * 存在匹配且生效的 deny 即禁止（与优先级无关）；否则取生效 allow 的最小 priority，
 * 同级取最短 maxSessionMs，requiresApproval 为同级任意一条的逻辑或。
 */
export declare function decideCompiled(compiled: readonly CompiledPolicy[], identity: Identity, environmentId: string, resourceType: string, utcMs: number): PolicyDecision;
/** 单时刻判定（每次调用重新解析窗口，非热路径使用） */
export declare function decideAt(policies: readonly Policy[], identity: Identity, environmentId: string, resourceType: string, utcMs: number): PolicyDecision;
