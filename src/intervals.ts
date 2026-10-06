/** 左闭右开毫秒区间 */
export interface Interval {
  start: number;
  end: number;
}

/** 合并重叠及首尾相接的区间（输入无需有序），返回有序不相交区间 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/**
 * 计算 a - b：两个有序不相交区间列表的差集，返回有序不相交区间。
 */
export function subtractIntervals(
  a: readonly Interval[],
  b: readonly Interval[],
): Interval[] {
  const result: Interval[] = [];
  let j = 0;
  for (const iv of a) {
    let cursor = iv.start;
    while (j < b.length) {
      const cut = b[j]!;
      if (cut.end <= cursor) {
        j++;
        continue;
      }
      if (cut.start >= iv.end) break;
      if (cut.start > cursor) result.push({ start: cursor, end: cut.start });
      if (cut.end >= iv.end) {
        cursor = iv.end;
        break;
      }
      cursor = cut.end;
      j++;
    }
    if (cursor < iv.end) result.push({ start: cursor, end: iv.end });
  }
  return result;
}
