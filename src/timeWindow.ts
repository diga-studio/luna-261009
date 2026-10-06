import type { DailyWindow } from './types.js';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2}) (AM|PM)$/;

/** 解析 "hh:mm AM/PM" 为一天内的分钟数（0..1439）。12:00 AM=0，12:00 PM=720。 */
export function parseTimeOfDay(value: string): number {
  const match = TIME_OF_DAY_RE.exec(value);
  if (!match) {
    throw new Error(`invalid time of day: ${JSON.stringify(value)}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) {
    throw new Error(`invalid time of day: ${JSON.stringify(value)}`);
  }
  const hour24 = (hour % 12) + (match[3] === 'PM' ? 12 : 0);
  return hour24 * 60 + minute;
}

/** 判断 UTC 时刻（毫秒）是否落在每日窗口内。起点含、终点不含；相等为全天。 */
export function isInWindow(window: DailyWindow, timeMs: number): boolean {
  const startMs = parseTimeOfDay(window.start) * MS_PER_MINUTE;
  const endMs = parseTimeOfDay(window.end) * MS_PER_MINUTE;
  if (startMs === endMs) {
    return true;
  }
  const tod = ((timeMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  if (startMs < endMs) {
    return tod >= startMs && tod < endMs;
  }
  return tod >= startMs || tod < endMs;
}
