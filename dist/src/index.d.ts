/** 临时闭区区间，UTC 毫秒，左闭右开 */
export interface ClosureInterval {
    start: number;
    end: number;
}
export interface ZoneConfig {
    /** 固定容量 C */
    capacity: number;
    /** 关闭日期，UTC 日期，格式 "YYYY-MM-DD" */
    closedDates?: string[];
    /** 临时闭区区间，UTC 毫秒，左闭右开 */
    closures?: ClosureInterval[];
}
export interface Slot {
    start: number;
    end: number;
    remaining: number;
}
export declare class FacilityZone {
    private readonly capacity;
    private readonly closed;
    private readonly bookings;
    constructor(config: ZoneConfig);
    upsertBooking(id: string, start: number, end: number, units: number): void;
    deleteBooking(id: string): void;
    /** 候选时隙是否与闭区相交 */
    private intersectsClosure;
    /** 时隙内的最大同时占用名额 */
    private maxConcurrent;
    listSlots(from: number, to: number, duration: number): Slot[];
}
