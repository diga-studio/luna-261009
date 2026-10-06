import type {
  EmployeeSettlement,
  SettlementRequest,
  SettlementResult,
  SettlementSegment,
  WorkInterval,
} from "./types.js";
import { addDays, localDateStartUtc, utcToLocalDate } from "./timezone.js";

const HOUR = 3600;
const DAILY_OT_THRESHOLD = 8 * HOUR;
const WEEKLY_OT_THRESHOLD = 40 * HOUR;
const CONTINUOUS_OT_THRESHOLD = 12 * HOUR;

class EmployeeAccumulator {
  daySeconds = 0;
  weekSeconds = 0;
  continuousSeconds: number;
  private currentEmpDate: string | null = null;
  private empDayEndUtc = 0;
  private currentLocId: string | null = null;
  private currentLocDate: string | null = null;
  private locDayEndUtc = 0;
  private locHolidayRate = 1;
  segments: SettlementSegment[] = [];
  totalSecondsByRate = { rate1: 0, rate1_5: 0, rate2: 0 };

  constructor(
    private readonly employeeId: string,
    private readonly employeeTimeZone: string,
    private readonly weekStartUtc: number,
    private readonly weekEndUtc: number,
    initialContinuousSeconds: number,
    private readonly locationTimeZones: Record<string, string>,
    private readonly holidayRates: Record<string, Record<string, 1.5 | 2>>,
  ) {
    this.continuousSeconds = initialContinuousSeconds;
  }

  private empDayEnd(pos: number): number {
    if (this.currentEmpDate === null || pos >= this.empDayEndUtc) {
      const date = utcToLocalDate(this.employeeTimeZone, pos);
      if (date !== this.currentEmpDate) {
        // 进入新的员工当地日（含空档跨午夜）：日累计归零。
        this.currentEmpDate = date;
        this.empDayEndUtc = localDateStartUtc(this.employeeTimeZone, addDays(date, 1));
        this.daySeconds = 0;
        if (pos >= this.weekEndUtc) {
          this.weekSeconds = 0;
        }
      }
    }
    return this.empDayEndUtc;
  }

  private locState(locationId: string, pos: number): { end: number; rate: number } {
    if (locationId !== this.currentLocId || pos >= this.locDayEndUtc) {
      const tz = this.locationTimeZones[locationId];
      const date = utcToLocalDate(tz, pos);
      if (locationId !== this.currentLocId || date !== this.currentLocDate) {
        this.currentLocId = locationId;
        this.currentLocDate = date;
        this.locDayEndUtc = localDateStartUtc(tz, addDays(date, 1));
        this.locHolidayRate = this.holidayRates[locationId]?.[date] ?? 1;
      }
    }
    return { end: this.locDayEndUtc, rate: this.locHolidayRate };
  }

  private emit(interval: WorkInterval, start: number, end: number, rate: number): void {
    const last = this.segments[this.segments.length - 1];
    if (
      last &&
      last.sourceId === interval.sourceId &&
      last.locationId === interval.locationId &&
      last.rate === rate &&
      last.endUtc === start
    ) {
      last.endUtc = end;
    } else {
      this.segments.push({
        employeeId: this.employeeId,
        sourceId: interval.sourceId,
        locationId: interval.locationId,
        startUtc: start,
        endUtc: end,
        rate,
      });
    }
    if (rate === 1) this.totalSecondsByRate.rate1 += end - start;
    else if (rate === 1.5) this.totalSecondsByRate.rate1_5 += end - start;
    else this.totalSecondsByRate.rate2 += end - start;
  }

  processInterval(interval: WorkInterval, isFirst: boolean): void {
    if (isFirst && interval.startUtc !== this.weekStartUtc) {
      // 第一段晚于周起点：期初连续工时失效。
      this.continuousSeconds = 0;
    }
    let pos = interval.startUtc;
    while (pos < interval.endUtc) {
      const dayEnd = this.empDayEnd(pos);
      const loc = this.locState(interval.locationId, pos);
      let next = Math.min(interval.endUtc, dayEnd, loc.end);
      if (this.daySeconds < DAILY_OT_THRESHOLD) {
        next = Math.min(next, pos + (DAILY_OT_THRESHOLD - this.daySeconds));
      }
      if (this.weekSeconds < WEEKLY_OT_THRESHOLD) {
        next = Math.min(next, pos + (WEEKLY_OT_THRESHOLD - this.weekSeconds));
      }
      if (this.continuousSeconds < CONTINUOUS_OT_THRESHOLD) {
        next = Math.min(next, pos + (CONTINUOUS_OT_THRESHOLD - this.continuousSeconds));
      }
      let rate = loc.rate;
      if (this.daySeconds >= DAILY_OT_THRESHOLD && rate < 1.5) rate = 1.5;
      if (this.weekSeconds >= WEEKLY_OT_THRESHOLD && rate < 1.5) rate = 1.5;
      if (this.continuousSeconds >= CONTINUOUS_OT_THRESHOLD && rate < 2) rate = 2;
      this.emit(interval, pos, next, rate);
      const dur = next - pos;
      this.daySeconds += dur;
      this.weekSeconds += dur;
      this.continuousSeconds += dur;
      if (next >= dayEnd) {
        this.daySeconds = 0;
        if (next >= this.weekEndUtc) {
          this.weekSeconds = 0;
        }
      }
      pos = next;
    }
  }

  resetContinuousOnGap(): void {
    this.continuousSeconds = 0;
  }
}

/** 执行一次完整批次结算。 */
export function settle(request: SettlementRequest): SettlementResult {
  const {
    weekStartLocalDate,
    employeeTimeZone,
    initialContinuousSeconds,
    locationTimeZones,
    holidayRates,
    intervals,
  } = request;

  const weekStartUtc = localDateStartUtc(employeeTimeZone, weekStartLocalDate);
  const weekEndUtc = localDateStartUtc(employeeTimeZone, addDays(weekStartLocalDate, 7));

  const byEmployee = new Map<string, WorkInterval[]>();
  for (const iv of intervals) {
    let list = byEmployee.get(iv.employeeId);
    if (!list) {
      list = [];
      byEmployee.set(iv.employeeId, list);
    }
    list.push(iv);
  }

  const employees: EmployeeSettlement[] = [];
  for (const [employeeId, list] of byEmployee) {
    list.sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc);
    const acc = new EmployeeAccumulator(
      employeeId,
      employeeTimeZone,
      weekStartUtc,
      weekEndUtc,
      initialContinuousSeconds,
      locationTimeZones,
      holidayRates,
    );
    let prevEnd = -1;
    for (const iv of list) {
      if (prevEnd >= 0 && iv.startUtc > prevEnd) {
        acc.resetContinuousOnGap();
      }
      acc.processInterval(iv, prevEnd < 0);
      prevEnd = iv.endUtc;
    }
    employees.push({
      employeeId,
      segments: acc.segments,
      totalSecondsByRate: acc.totalSecondsByRate,
    });
  }
  employees.sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));
  return { employees };
}
