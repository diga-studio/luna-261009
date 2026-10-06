/** 左闭右开毫秒区间 */
export interface Interval {
    start: number;
    end: number;
}
/** 合并重叠及首尾相接的区间（输入无需有序），返回有序不相交区间 */
export declare function mergeIntervals(intervals: readonly Interval[]): Interval[];
/**
 * 计算 a - b：两个有序不相交区间列表的差集，返回有序不相交区间。
 */
export declare function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[];
