/** 时区工具：基于 Intl 的 IANA 时区偏移与当地日期边界计算。 */

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
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
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function getLocalParts(timeZone: string, utcSeconds: number): DateParts {
  const fmt = getFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(utcSeconds * 1000));
  const out: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** 返回某 UTC 时刻（epoch 秒）在指定 IANA 时区的偏移秒数（当地 = UTC + offset）。 */
export function getOffsetSeconds(timeZone: string, utcSeconds: number): number {
  const lp = getLocalParts(timeZone, utcSeconds);
  const asUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second) / 1000;
  return asUtc - utcSeconds;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/** 将 UTC epoch 秒转换为指定时区的当地日期字符串 YYYY-MM-DD。 */
export function utcToLocalDate(timeZone: string, utcSeconds: number): string {
  const lp = getLocalParts(timeZone, utcSeconds);
  return `${lp.year}-${pad2(lp.month)}-${pad2(lp.day)}`;
}

/** 当地日期字符串加 n 天。 */
export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d + days) / 1000;
  const dt = new Date(t * 1000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * 返回指定时区某当地日期（YYYY-MM-DD）首个真实时刻的 UTC epoch 秒。
 * 即当地日历刚进入该日期的第一秒；对因夏令时而不存在的当地钟点不做虚构。
 */
const dayStartCache = new Map<string, number>();

export function localDateStartUtc(timeZone: string, localDate: string): number {
  const key = timeZone + "|" + localDate;
  const hit = dayStartCache.get(key);
  if (hit !== undefined) return hit;
  const value = computeLocalDateStartUtc(timeZone, localDate);
  dayStartCache.set(key, value);
  return value;
}

function computeLocalDateStartUtc(timeZone: string, localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12) / 1000;
  // 以当地正午为参照估计偏移，划定必然包含日界线的搜索窗口。
  const approxOffset = getOffsetSeconds(timeZone, noonUtc);
  let lo = Date.UTC(y, m - 1, d) / 1000 - approxOffset - 86400;
  let hi = lo + 2 * 86400;
  // 二分查找第一个当地日期等于 localDate 的 UTC 秒。
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (utcToLocalDate(timeZone, mid) >= localDate) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}
