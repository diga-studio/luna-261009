import { TimeZoneCache } from "./timezone.js";
const HOUR_MS = 3600000;
const DAY_LIMIT_MS = 8 * HOUR_MS;
const WEEK_LIMIT_MS = 40 * HOUR_MS;
const CONTINUOUS_LIMIT_MS = 12 * HOUR_MS;
/** 当地日期加 n 天（纯历法运算）。 */
function addDays(date, n) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}
function toUtcIso(utcMs) {
    const iso = new Date(utcMs).toISOString();
    return utcMs % 1000 === 0 ? iso.slice(0, 19) + "Z" : iso;
}
function parseInstant(instant, field) {
    const ms = Date.parse(instant);
    if (Number.isNaN(ms)) {
        throw new Error(`invalid UTC instant for ${field}: ${instant}`);
    }
    return ms;
}
class EmployeeSettler {
    constructor(tz, ctx, weekStartMs, dayStartsMs, input) {
        this.tz = tz;
        this.ctx = ctx;
        this.weekStartMs = weekStartMs;
        this.dayStartsMs = dayStartsMs;
        this.input = input;
        this.dailyMs = 0;
        this.weeklyMs = 0;
        this.continuousMs = 0;
        this.prevEndMs = null;
        this.dayIndex = 0;
        this.segments = [];
        this.regularMs = 0;
        this.timeAndHalfMs = 0;
        this.doubleMs = 0;
    }
    settle(intervals) {
        const first = intervals[0];
        if (first !== undefined && first.startMs === this.weekStartMs) {
            this.continuousMs = this.ctx.initialContinuousSeconds * 1000;
        }
        for (const interval of intervals) {
            this.settleInterval(interval);
        }
    }
    result() {
        return {
            segments: this.segments,
            totals: {
                regular: this.regularMs / 1000,
                timeAndHalf: this.timeAndHalfMs / 1000,
                double: this.doubleMs / 1000,
            },
        };
    }
    settleInterval(interval) {
        if (this.prevEndMs !== null && interval.startMs > this.prevEndMs) {
            this.continuousMs = 0;
        }
        this.prevEndMs = interval.endMs;
        const locationTimeZone = this.input.locationTimeZones[interval.locationId];
        if (locationTimeZone === undefined) {
            throw new Error(`unknown locationId: ${interval.locationId}`);
        }
        const holidayTable = this.input.holidayRates[interval.locationId];
        let cursor = interval.startMs;
        while (this.dayIndex + 1 < this.dayStartsMs.length && cursor >= this.dayStartsMs[this.dayIndex + 1]) {
            this.dayIndex += 1;
            this.dailyMs = 0;
        }
        let locationDate = this.tz.localDate(locationTimeZone, cursor);
        let nextLocationBoundary = this.tz.dayStartUtcMs(locationTimeZone, addDays(locationDate, 1));
        while (cursor < interval.endMs) {
            const nextDayBoundary = this.dayIndex + 1 < this.dayStartsMs.length ? this.dayStartsMs[this.dayIndex + 1] : Number.POSITIVE_INFINITY;
            let next = interval.endMs;
            if (nextDayBoundary < next)
                next = nextDayBoundary;
            if (nextLocationBoundary < next)
                next = nextLocationBoundary;
            if (this.dailyMs < DAY_LIMIT_MS) {
                const at = cursor + (DAY_LIMIT_MS - this.dailyMs);
                if (at < next)
                    next = at;
            }
            if (this.weeklyMs < WEEK_LIMIT_MS) {
                const at = cursor + (WEEK_LIMIT_MS - this.weeklyMs);
                if (at < next)
                    next = at;
            }
            if (this.continuousMs < CONTINUOUS_LIMIT_MS) {
                const at = cursor + (CONTINUOUS_LIMIT_MS - this.continuousMs);
                if (at < next)
                    next = at;
            }
            const holidayRate = holidayTable?.[locationDate] ?? 1;
            let rate = holidayRate;
            if (this.dailyMs >= DAY_LIMIT_MS && rate < 1.5)
                rate = 1.5;
            if (this.weeklyMs >= WEEK_LIMIT_MS && rate < 1.5)
                rate = 1.5;
            if (this.continuousMs >= CONTINUOUS_LIMIT_MS && rate < 2)
                rate = 2;
            const segmentMs = next - cursor;
            if (segmentMs > 0) {
                this.segments.push({
                    sourceId: interval.sourceId,
                    startUtc: toUtcIso(cursor),
                    endUtc: toUtcIso(next),
                    rate: rate,
                });
                if (rate === 2)
                    this.doubleMs += segmentMs;
                else if (rate === 1.5)
                    this.timeAndHalfMs += segmentMs;
                else
                    this.regularMs += segmentMs;
                this.dailyMs += segmentMs;
                this.weeklyMs += segmentMs;
                this.continuousMs += segmentMs;
            }
            cursor = next;
            if (cursor === nextDayBoundary) {
                this.dayIndex += 1;
                this.dailyMs = 0;
            }
            if (cursor === nextLocationBoundary) {
                locationDate = addDays(locationDate, 1);
                nextLocationBoundary = this.tz.dayStartUtcMs(locationTimeZone, addDays(locationDate, 1));
            }
        }
    }
}
/** 完整批次结算：输入与结果均在内存中。 */
export function settleWeek(input) {
    const tz = new TimeZoneCache();
    const contexts = new Map();
    for (const ctx of input.employees) {
        contexts.set(ctx.employeeId, ctx);
    }
    const intervalsByEmployee = new Map();
    for (const interval of input.intervals) {
        const startMs = parseInstant(interval.startUtc, "startUtc");
        const endMs = parseInstant(interval.endUtc, "endUtc");
        if (endMs <= startMs) {
            throw new Error(`interval ${interval.sourceId} has non-positive length`);
        }
        if (!contexts.has(interval.employeeId)) {
            throw new Error(`unknown employeeId: ${interval.employeeId}`);
        }
        let list = intervalsByEmployee.get(interval.employeeId);
        if (list === undefined) {
            list = [];
            intervalsByEmployee.set(interval.employeeId, list);
        }
        list.push({ ...interval, startMs, endMs });
    }
    const employees = input.employees.map((ctx) => {
        const weekStartMs = tz.dayStartUtcMs(ctx.accountingTimeZone, ctx.weekStartLocalDate);
        const dayStartsMs = [];
        for (let i = 0; i <= 7; i += 1) {
            dayStartsMs.push(tz.dayStartUtcMs(ctx.accountingTimeZone, addDays(ctx.weekStartLocalDate, i)));
        }
        const intervals = intervalsByEmployee.get(ctx.employeeId) ?? [];
        intervals.sort((a, b) => a.startMs - b.startMs);
        const settler = new EmployeeSettler(tz, ctx, weekStartMs, dayStartsMs, input);
        settler.settle(intervals);
        const { segments, totals } = settler.result();
        return { employeeId: ctx.employeeId, segments, totals };
    });
    return { employees };
}
