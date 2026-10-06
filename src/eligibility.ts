import { DatabaseSync } from "node:sqlite";
import {
  QUOTA_MAX_PER_WINDOW,
  QUOTA_WINDOW_MS,
  SAME_TARGET_MIN_GAP_MS,
  Target,
} from "./types.js";

export interface OccupiedSlot {
  targetType: string;
  targetId: string;
  serviceTime: number;
}

export function loadOccupiedSlots(
  db: DatabaseSync,
  staffId: string,
  now: number,
): OccupiedSlot[] {
  const rows = db
    .prepare(
      `SELECT t.target_type AS targetType, t.target_id AS targetId, t.service_time AS serviceTime
       FROM invitations i
       JOIN tasks t ON t.id = i.task_id
       WHERE i.staff_id = ?
         AND (i.status = 'accepted' OR (i.status = 'pending' AND i.expires_at > ?))`,
    )
    .all(staffId, now);
  return rows.map((row) => ({
    targetType: row.targetType as string,
    targetId: row.targetId as string,
    serviceTime: row.serviceTime as number,
  }));
}

export function isStaffEligible(
  db: DatabaseSync,
  staffId: string,
  target: Target,
  serviceTime: number,
  now: number,
): boolean {
  const slots = loadOccupiedSlots(db, staffId, now);
  return (
    respectsSameTargetGap(slots, target, serviceTime) &&
    respectsWindowQuota(slots, serviceTime)
  );
}

function respectsSameTargetGap(
  slots: OccupiedSlot[],
  target: Target,
  serviceTime: number,
): boolean {
  for (const slot of slots) {
    if (slot.targetType === target.type && slot.targetId === target.id) {
      if (Math.abs(slot.serviceTime - serviceTime) < SAME_TARGET_MIN_GAP_MS) {
        return false;
      }
    }
  }
  return true;
}

function respectsWindowQuota(slots: OccupiedSlot[], serviceTime: number): boolean {
  const times = slots.map((slot) => slot.serviceTime);
  times.push(serviceTime);
  const starts = new Set<number>();
  for (const time of times) {
    if (time > serviceTime - QUOTA_WINDOW_MS && time <= serviceTime) {
      starts.add(time);
    }
  }
  for (const start of starts) {
    let count = 0;
    for (const time of times) {
      if (time >= start && time < start + QUOTA_WINDOW_MS) {
        count += 1;
      }
    }
    if (count > QUOTA_MAX_PER_WINDOW) {
      return false;
    }
  }
  return true;
}
