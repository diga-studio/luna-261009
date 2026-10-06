import type { DailyWindow } from './types.js';

const MS_PER_DAY = 86_400_000;
const TIME_RE = /^(\d{1,2}):([0-5]\d) (AM|PM)$/;

/** 解析 "hh:mm AM/PM" 为当日毫秒数（整分钟）。12:00 AM=午夜，12:00 PM=正午 */
export function parseTimeOfDay(text: string): number {
  const m = TIME_RE.exec(text);
  if (!m) throw new Error(`invalid time of day: ${text}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12) throw new Error(`invalid hour: ${text}`);
  const h24 = (hour % 12) + (m[3] === 'PM' ? 12 : 0);
  return (h24 * 60 + minute) * 60_000;
}

/** 已解析窗口（当日毫秒）的包含判断：起点含、终点不含；起终相等表示全天 */
export function windowContainsParsed(
  windowStartMs: number,
  windowEndMs: number,
  utcMs: number,
): boolean {
  if (windowStartMs === windowEndMs) return true;
  const msOfDay = ((utcMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  if (windowStartMs < windowEndMs) {
    return msOfDay >= windowStartMs && msOfDay < windowEndMs;
  }
  return msOfDay >= windowStartMs || msOfDay < windowEndMs;
}

/** 判断 UTC 毫秒时刻是否落在每日窗口内 */
export function windowContains(window: DailyWindow, utcMs: number): boolean {
  return windowContainsParsed(
    parseTimeOfDay(window.start),
    parseTimeOfDay(window.end),
    utcMs,
  );
}
