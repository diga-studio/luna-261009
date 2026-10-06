/**
 * Facility zone bookable-slot computation.
 *
 * All times are UTC integer milliseconds. Dates are interpreted in UTC.
 * The timeline is limited to the years 2025..2034 (UTC).
 * Business hours are fixed at 05:00..21:00 UTC every day.
 * Slot start times always align to the 30-minute grid anchored at 05:00 UTC
 * of each day; query bounds and closures never re-anchor the grid.
 * All intervals are half-open: [start, end).
 */

export const MIN_YEAR = 2025;
export const MAX_YEAR = 2034;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const GRID_MS = 30 * 60 * 1000;

const BUSINESS_START_MS = 5 * 60 * 60 * 1000; // 05:00
const BUSINESS_END_MS = 21 * 60 * 60 * 1000; // 21:00
const TIMELINE_START = Date.UTC(MIN_YEAR, 0, 1);
const TIMELINE_END = Date.UTC(MAX_YEAR + 1, 0, 1); // exclusive

/** A half-open interval [start, end) in UTC milliseconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Configuration fixed at construction time. */
export interface ZoneConfig {
  /** Fixed capacity (max simultaneous units). */
  capacity: number;
  /**
   * Closed dates: each value is a UTC millisecond timestamp; the whole UTC
   * calendar day containing that timestamp is closed.
   */
  closedDates?: number[];
  /** Temporary closures: half-open intervals [start, end) in UTC ms. */
  closures?: TimeRange[];
}

export interface Slot {
  start: number;
  end: number;
  remaining: number;
}

interface Booking {
  start: number;
  end: number;
  units: number;
}

function dayStartOf(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

export class FacilityZone {
  private readonly capacity: number;
  private readonly closedDayStarts: Set<number>;
  private readonly closures: TimeRange[];
  private readonly bookings: Map<string, Booking>;

  constructor(config: ZoneConfig) {
    if (!Number.isFinite(config.capacity) || config.capacity <= 0) {
      throw new RangeError("capacity must be a positive number");
    }
    this.capacity = config.capacity;
    this.closedDayStarts = new Set(
      (config.closedDates ?? []).map((ts) => dayStartOf(ts)),
    );
    this.closures = (config.closures ?? [])
      .filter((c) => c.start < c.end)
      .map((c) => ({ start: c.start, end: c.end }));
    this.bookings = new Map();
  }

  /** Add or fully replace the occupancy recorded under `id`. */
  upsertBooking(id: string, start: number, end: number, units: number): void {
    if (!(start < end)) {
      throw new RangeError("booking start must be before end");
    }
    if (!(units > 0)) {
      throw new RangeError("booking units must be positive");
    }
    this.bookings.set(id, { start, end, units });
  }

  /** Remove the booking with `id`; unknown ids leave state unchanged. */
  deleteBooking(id: string): void {
    this.bookings.delete(id);
  }

  /**
   * List bookable slots of length `duration` fully contained in [from, to).
   * `duration` must be a positive multiple of 30 minutes.
   */
  listSlots(from: number, to: number, duration: number): Slot[] {
    if (!(duration > 0) || duration % GRID_MS !== 0) {
      throw new RangeError("duration must be a positive multiple of 30 minutes");
    }
    const lo = Math.max(from, TIMELINE_START);
    const hi = Math.min(to, TIMELINE_END);
    if (lo >= hi) return [];

    const slots: Slot[] = [];
    for (let day = dayStartOf(lo); day < hi; day += DAY_MS) {
      if (this.closedDayStarts.has(day)) continue;
      const open = day + BUSINESS_START_MS;
      const close = day + BUSINESS_END_MS;
      for (let start = open; start + duration <= close; start += GRID_MS) {
        const end = start + duration;
        if (start < lo || end > hi) continue;
        if (this.intersectsClosure(start, end)) continue;
        const remaining = this.capacity - this.maxConcurrentUnits(start, end);
        if (remaining > 0) slots.push({ start, end, remaining });
      }
    }
    return slots;
  }

  private intersectsClosure(start: number, end: number): boolean {
    for (const c of this.closures) {
      if (c.start < end && c.end > start) return true;
    }
    return false;
  }

  /** Maximum simultaneous occupied units within [start, end). */
  private maxConcurrentUnits(start: number, end: number): number {
    const deltas = new Map<number, number>();
    for (const b of this.bookings.values()) {
      if (b.start >= end || b.end <= start) continue;
      const s = Math.max(b.start, start);
      const e = Math.min(b.end, end);
      deltas.set(s, (deltas.get(s) ?? 0) + b.units);
      deltas.set(e, (deltas.get(e) ?? 0) - b.units);
    }
    const times = [...deltas.keys()].sort((a, b) => a - b);
    let current = 0;
    let max = 0;
    for (const t of times) {
      current += deltas.get(t)!;
      if (t < end && current > max) max = current;
    }
    return max;
  }
}
