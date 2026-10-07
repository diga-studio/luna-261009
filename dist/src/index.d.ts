import { DisciplineState, PenaltyId, PeriodDossier } from "./types.js";
export { Directive, DisciplineState, Penalty, PenaltyId, PeriodDossier } from "./types.js";
/**
 * 单个领导、单个评价周期的纪律历史。
 *
 * 通过 constructor 指定不可变的周期窗口 [periodStart, periodEnd)，
 * 然后调用一次 load() 装载完整资料；此后只允许 revokePenalty() 与 query()。
 * 撤销代表成功申诉：该处罚视为在整个周期内从未提供过处分资格，
 * 所有人工指令按更正后的事实重新判定。
 */
export declare class DisciplineHistory {
    readonly periodStart: number;
    readonly periodEnd: number;
    private timeline;
    private penalties;
    private revoked;
    constructor(periodStart: number, periodEnd: number);
    /** 装载完整资料，只能调用一次。 */
    load(dossier: PeriodDossier): void;
    /**
     * 撤销处罚（成功申诉）。返回是否本次撤销生效；
     * 撤销未知编号或重复撤销均返回 false，无额外效果。
     */
    revokePenalty(id: PenaltyId): boolean;
    /** 查询 time 秒处理完全部变化后的状态。 */
    query(time: number): DisciplineState;
    private requireLoaded;
}
