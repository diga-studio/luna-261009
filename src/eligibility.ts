import type { TargetRef } from "./types.js";
import {
  MAX_OCCUPANCY_PER_24H,
  MIN_TARGET_GAP_MS,
  WINDOW_24H_MS,
} from "./types.js";

export interface OccupancyEntry {
  target: TargetRef;
  serviceTimeMs: number;
}

export function canOccupy(
  existing: OccupancyEntry[],
  target: TargetRef,
  serviceTimeMs: number,
): boolean {
  for (const entry of existing) {
    if (entry.target.type === target.type && entry.target.id === target.id) {
      const gap = Math.abs(entry.serviceTimeMs - serviceTimeMs);
      if (gap < MIN_TARGET_GAP_MS) {
        return false;
      }
    }
  }

  const times = existing
    .map((entry) => entry.serviceTimeMs)
    .concat(serviceTimeMs)
    .sort((a, b) => a - b);

  let end = 0;
  for (let start = 0; start < times.length; start += 1) {
    const startTime = times[start];
    if (startTime === undefined) {
      continue;
    }
    while (
      end < times.length &&
      (times[end] as number) < startTime + WINDOW_24H_MS
    ) {
      end += 1;
    }
    if (end - start > MAX_OCCUPANCY_PER_24H) {
      return false;
    }
  }
  return true;
}
