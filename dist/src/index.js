"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FacilityZone = void 0;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRID_MS = 30 * 60 * 1000;
const OPEN_OFFSET_MS = 5 * 60 * 60 * 1000; // 每天 05:00 开门
const CLOSE_OFFSET_MS = 21 * 60 * 60 * 1000; // 每天 21:00 打烊
const TIMELINE_START = Date.UTC(2025, 0, 1);
const TIMELINE_END = Date.UTC(2035, 0, 1); // 左闭右开，覆盖 2025–2034
function utcMidnight(t) {
    return Math.floor(t / DAY_MS) * DAY_MS;
}
function parseDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) {
        throw new RangeError(`invalid closed date: ${date}`);
    }
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
/** 合并为排序后的不相交区间 */
function mergeIntervals(intervals) {
    const sorted = intervals
        .filter((i) => i.start < i.end)
        .slice()
        .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (last && interval.start <= last.end) {
            last.end = Math.max(last.end, interval.end);
        }
        else {
            merged.push({ start: interval.start, end: interval.end });
        }
    }
    return merged;
}
class FacilityZone {
    constructor(config) {
        this.bookings = new Map();
        if (!Number.isInteger(config.capacity) || config.capacity < 0) {
            throw new RangeError("capacity must be a non-negative integer");
        }
        this.capacity = config.capacity;
        const intervals = [];
        for (const date of config.closedDates ?? []) {
            const day = parseDate(date);
            intervals.push({ start: day, end: day + DAY_MS });
        }
        for (const closure of config.closures ?? []) {
            intervals.push({ start: closure.start, end: closure.end });
        }
        this.closed = mergeIntervals(intervals);
    }
    upsertBooking(id, start, end, units) {
        if (!(start < end)) {
            throw new RangeError("booking start must be before end");
        }
        if (!Number.isInteger(units) || units <= 0) {
            throw new RangeError("units must be a positive integer");
        }
        this.bookings.set(id, { start, end, units });
    }
    deleteBooking(id) {
        this.bookings.delete(id);
    }
    /** 候选时隙是否与闭区相交 */
    intersectsClosure(start, end) {
        for (const interval of this.closed) {
            if (interval.start >= end)
                break;
            if (interval.end > start)
                return true;
        }
        return false;
    }
    /** 时隙内的最大同时占用名额 */
    maxConcurrent(start, end) {
        const events = [];
        for (const booking of this.bookings.values()) {
            if (booking.end <= start || booking.start >= end)
                continue;
            events.push({ t: Math.max(booking.start, start), delta: booking.units });
            events.push({ t: Math.min(booking.end, end), delta: -booking.units });
        }
        events.sort((a, b) => a.t - b.t || a.delta - b.delta);
        let current = 0;
        let peak = 0;
        for (const event of events) {
            current += event.delta;
            if (current > peak)
                peak = current;
        }
        return peak;
    }
    listSlots(from, to, duration) {
        if (!Number.isInteger(duration) || duration <= 0 || duration % GRID_MS !== 0) {
            throw new RangeError("duration must be a positive multiple of 30 minutes");
        }
        const rangeStart = Math.max(from, TIMELINE_START);
        const rangeEnd = Math.min(to, TIMELINE_END);
        const slots = [];
        if (rangeEnd - rangeStart < duration)
            return slots;
        for (let day = utcMidnight(rangeStart); day < rangeEnd; day += DAY_MS) {
            const open = day + OPEN_OFFSET_MS;
            const close = day + CLOSE_OFFSET_MS;
            for (let start = open; start + duration <= close; start += GRID_MS) {
                const end = start + duration;
                if (end <= rangeStart)
                    continue;
                if (start >= rangeEnd)
                    break;
                if (start < rangeStart || end > rangeEnd)
                    continue;
                if (this.intersectsClosure(start, end))
                    continue;
                const remaining = this.capacity - this.maxConcurrent(start, end);
                if (remaining > 0) {
                    slots.push({ start, end, remaining });
                }
            }
        }
        return slots;
    }
}
exports.FacilityZone = FacilityZone;
