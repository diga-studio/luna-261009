import { Directive, DisciplineState } from "./types.js";
/**
 * 时间轴段树。
 *
 * 把周期内所有事件点（处罚区间边界、指令时间、周期起点）压缩为叶子。
 * 每个叶子保存该秒的状态转移函数（4 个状态上的映射，含必要的自动降级
 * 与该秒全部人工指令），内部节点保存子区间转移函数的复合。
 *
 * 撤销处罚 = 对覆盖计数做区间减一；计数只减不增，每个叶子最多发生一次
 * "归零翻转"，翻转时把叶子函数切换为零覆盖版本并沿树上推。
 * 查询 = 前缀函数复合作用于初始状态（无处分）。
 */
export declare class Timeline {
    private readonly periodStart;
    private readonly periodEnd;
    private penaltyStarts;
    private penaltyEnds;
    private directives;
    private times;
    private m;
    private mn;
    private lz;
    private fn;
    private leafZero;
    private built;
    constructor(periodStart: number, periodEnd: number);
    addPenalty(start: number, end: number): void;
    addDirective(directive: Directive): void;
    build(): void;
    private buildNode;
    private pull;
    private push;
    /** 撤销 [start, end) 的覆盖。 */
    removeCoverage(start: number, end: number): void;
    private addRange;
    private rangeMin;
    /** 找到 [ql,qr] 内最左的未翻转零计数叶子并翻转。 */
    private flipLeftmostZero;
    /** 处理完 time 秒全部变化后的状态。 */
    query(time: number): DisciplineState;
    private collect;
}
