const HOUR_MS = 3600000;
function pad2(n) {
    return n < 10 ? "0" + n : String(n);
}
/**
 * 基于 Intl 的 IANA 时区工具，带缓存。
 * 只负责：UTC 时刻 -> 当地日期、当地日期 -> 该日期首个真实 UTC 时刻。
 */
export class TimeZoneCache {
    constructor() {
        this.formatters = new Map();
        this.dayStarts = new Map();
    }
    formatter(timeZone) {
        let fmt = this.formatters.get(timeZone);
        if (fmt === undefined) {
            fmt = new Intl.DateTimeFormat("en-US", {
                timeZone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23",
            });
            this.formatters.set(timeZone, fmt);
        }
        return fmt;
    }
    partsAt(timeZone, utcMs) {
        const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
        for (const p of this.formatter(timeZone).formatToParts(new Date(utcMs))) {
            switch (p.type) {
                case "year":
                    parts.year = Number(p.value);
                    break;
                case "month":
                    parts.month = Number(p.value);
                    break;
                case "day":
                    parts.day = Number(p.value);
                    break;
                case "hour":
                    parts.hour = Number(p.value) % 24;
                    break;
                case "minute":
                    parts.minute = Number(p.value);
                    break;
                case "second":
                    parts.second = Number(p.value);
                    break;
                default:
                    break;
            }
        }
        return parts;
    }
    /** 某 UTC 时刻（毫秒）在指定时区的当地日期 YYYY-MM-DD。 */
    localDate(timeZone, utcMs) {
        const p = this.partsAt(timeZone, utcMs);
        return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    }
    /** 指定时区某当地日期的首个真实时刻（UTC 毫秒）。 */
    dayStartUtcMs(timeZone, date) {
        const key = timeZone + "|" + date;
        const cached = this.dayStarts.get(key);
        if (cached !== undefined)
            return cached;
        const result = this.computeDayStart(timeZone, date);
        this.dayStarts.set(key, result);
        return result;
    }
    /**
     * 计算当地日期首个真实时刻。
     * 快速路径：按正午偏移估计的午夜恰为目标日 00:00:00。
     * 慢速路径（当日存在夏令时切换或午夜被跳过）：二分第一个
     * localDate >= date 的 UTC 毫秒。
     */
    computeDayStart(timeZone, date) {
        const year = Number(date.slice(0, 4));
        const month = Number(date.slice(5, 7));
        const day = Number(date.slice(8, 10));
        const targetUtcMidnight = Date.UTC(year, month - 1, day);
        const noonMs = targetUtcMidnight + 12 * HOUR_MS;
        const noonParts = this.partsAt(timeZone, noonMs);
        const offsetMs = Date.UTC(noonParts.year, noonParts.month - 1, noonParts.day, noonParts.hour, noonParts.minute, noonParts.second) - noonMs;
        const guess = targetUtcMidnight - offsetMs;
        const p = this.partsAt(timeZone, guess);
        if (p.year === year &&
            p.month === month &&
            p.day === day &&
            p.hour === 0 &&
            p.minute === 0 &&
            p.second === 0) {
            return guess;
        }
        let lo = guess - 3 * HOUR_MS;
        let hi = guess + 3 * HOUR_MS;
        while (this.localDate(timeZone, lo) >= date)
            lo -= HOUR_MS;
        while (this.localDate(timeZone, hi) < date)
            hi += HOUR_MS;
        while (hi - lo > 1) {
            const mid = lo + Math.floor((hi - lo) / 2);
            if (this.localDate(timeZone, mid) >= date)
                hi = mid;
            else
                lo = mid;
        }
        return hi;
    }
}
