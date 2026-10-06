declare type LocalDateString = string;
/**
 * 基于 Intl 的 IANA 时区工具，带缓存。
 * 只负责：UTC 时刻 -> 当地日期、当地日期 -> 该日期首个真实 UTC 时刻。
 */
export declare class TimeZoneCache {
    private readonly formatters;
    private readonly dayStarts;
    constructor();
    private formatter;
    private partsAt;
    /** 某 UTC 时刻（毫秒）在指定时区的当地日期 YYYY-MM-DD。 */
    localDate(timeZone: string, utcMs: number): LocalDateString;
    /** 指定时区某当地日期的首个真实时刻（UTC 毫秒）。 */
    dayStartUtcMs(timeZone: string, date: LocalDateString): number;
    /**
     * 计算当地日期首个真实时刻。
     * 快速路径：按正午偏移估计的午夜恰为目标日 00:00:00。
     * 慢速路径（当日存在夏令时切换或午夜被跳过）：二分第一个
     * localDate >= date 的 UTC 毫秒。
     */
    private computeDayStart;
}
export {};
