interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatCache: { [zone: string]: Intl.DateTimeFormat } = {};

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatCache[timeZone];
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
    formatCache[timeZone] = fmt;
  }
  return fmt;
}

/** Local wall-clock parts of an epoch-ms instant in the given zone. */
export function localParts(t: number, timeZone: string): LocalParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(t));
  const out: { [k: string]: number } = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = parseInt(p.value, 10);
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

/** Offset (zone local minus UTC) in milliseconds at instant t. */
function offsetMs(t: number, timeZone: string): number {
  const p = localParts(t, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Converts a local wall-clock time in the given zone to epoch-ms.
 * Iterates once to settle on the correct offset across DST transitions.
 */
function localToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = guess - offsetMs(guess, timeZone);
  const again = guess - offsetMs(utc, timeZone);
  if (again !== utc) utc = again;
  return utc;
}

/**
 * Returns the smallest epoch-ms t' >= t whose local time in the given IANA
 * zone falls inside the allowed window [windowStartHour, windowEndHour).
 */
export function nextAllowedTime(
  t: number,
  timeZone: string,
  windowStartHour: number,
  windowEndHour: number
): number {
  const p = localParts(t, timeZone);
  const inWindow = p.hour >= windowStartHour && p.hour < windowEndHour;
  if (inWindow) return t;
  if (p.hour < windowStartHour) {
    // Before the window opens: same local day at windowStartHour:00.
    return localToUtc(timeZone, p.year, p.month, p.day, windowStartHour, 0);
  }
  // At/after windowEndHour: next local day at windowStartHour:00.
  const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return localToUtc(
    timeZone,
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    windowStartHour,
    0
  );
}
