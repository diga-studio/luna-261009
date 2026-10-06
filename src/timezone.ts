/**
 * America/New_York 时区辅助：基于 Intl，无需任何外部依赖，自动处理夏令时。
 */

const TZ = "America/New_York";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(utcMs: number): LocalParts {
  const parts = formatter.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`missing part ${type}`);
    return Number(p.value);
  };
  let hour = get("hour");
  if (hour === 24) hour = 0; // 个别环境 hour12:false 仍返回 24
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** 该 UTC 瞬间对应的纽约当地时间，按“本地墙钟即 UTC”求值得到的毫秒数 */
function localAsUtcMs(utcMs: number): number {
  const p = localParts(utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** 纽约当地日期（year/month/day）的某个墙钟时刻，对应的 UTC 毫秒。 */
function zonedTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  // 迭代求不动点：guess 处偏移量稳定后即正确（08:00 不会落在 DST 缺口内）。
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 4; i += 1) {
    const offsetMs = localAsUtcMs(guess) - guess;
    const next = Date.UTC(year, month - 1, day, hour, minute) - offsetMs;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** 该瞬间是否处于允许尝试的窗口内：当地时间 [08:00, 21:00)。 */
export function isWithinSendingWindow(utcMs: number): boolean {
  const p = localParts(utcMs);
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 8 * 60 && minutes < 21 * 60;
}

/** 严格晚于 utcMs 的下一个窗口起点（当地 08:00）对应的 UTC 毫秒。 */
export function nextWindowStartMs(utcMs: number): number {
  const p = localParts(utcMs);
  let candidate = zonedTimeToUtcMs(p.year, p.month, p.day, 8, 0);
  if (candidate <= utcMs) {
    const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    candidate = zonedTimeToUtcMs(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      8,
      0,
    );
  }
  return candidate;
}
