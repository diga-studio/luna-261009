import { ReviewEvent, ReviewState } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 间隔阶梯（天）：1、3、7、14、30，进入 30 天后保持 30 天 */
const INTERVALS = [1, 3, 7, 14, 30];

/** UTC 自然日编号 */
function dayOf(occurredAt: number): number {
  return Math.floor(occurredAt / DAY_MS);
}

interface PairProjection {
  status: "inactive" | "pending" | "mastered";
  level: number;
  dueDay: number | null;
}

/**
 * 错词间隔复习组件。
 * 数据保存在进程内；同一 eventId 重复提交只生效一次；
 * 投影按 (occurredAt 升序, eventId ASCII 字典序) 重放，与到达顺序无关。
 */
export class WordReview {
  private readonly seenEventIds = new Set<string>();
  private readonly eventsByPair = new Map<string, ReviewEvent[]>();
  private readonly cache = new Map<string, PairProjection>();

  /** 接收一条事件；重复 eventId 幂等。 */
  ingest(event: ReviewEvent): void {
    if (this.seenEventIds.has(event.eventId)) return;
    this.seenEventIds.add(event.eventId);
    const key = pairKey(event.studentId, event.wordId);
    let bucket = this.eventsByPair.get(key);
    if (!bucket) {
      bucket = [];
      this.eventsByPair.set(key, bucket);
    }
    bucket.push(event);
    this.cache.delete(key);
  }

  /** 查询某学生某词的当前复习状态。 */
  getState(studentId: string, wordId: string): ReviewState {
    const key = pairKey(studentId, wordId);
    let projection = this.cache.get(key);
    if (!projection) {
      projection = replay(this.eventsByPair.get(key) ?? []);
      this.cache.set(key, projection);
    }
    if (projection.status === "pending") {
      return {
        status: "pending",
        intervalDays: INTERVALS[projection.level],
        dueAt: projection.dueDay! * DAY_MS,
      };
    }
    return { status: projection.status, intervalDays: null, dueAt: null };
  }
}

function pairKey(studentId: string, wordId: string): string {
  return JSON.stringify([studentId, wordId]);
}

/** 按规定顺序重放事件，得到确定性投影。 */
function replay(events: ReviewEvent[]): PairProjection {
  const sorted = [...events].sort(
    (a, b) => a.occurredAt - b.occurredAt || compareAscii(a.eventId, b.eventId)
  );
  let status: PairProjection["status"] = "inactive";
  let level = 0;
  let dueDay: number | null = null;
  for (const event of sorted) {
    if (status === "mastered") break; // mastered 为永久终态
    switch (event.kind) {
      case "incorrect":
        // 激活或重置为 1 天间隔，到期日为错误发生日 +1 天
        status = "pending";
        level = 0;
        dueDay = dayOf(event.occurredAt) + 1;
        break;
      case "correct":
        // 仅在已激活且发生日不早于到期日时生效，推进一级
        if (status === "pending" && dayOf(event.occurredAt) >= dueDay!) {
          level = Math.min(level + 1, INTERVALS.length - 1);
          dueDay = dayOf(event.occurredAt) + INTERVALS[level];
        }
        break;
      case "mastered":
        status = "mastered";
        level = 0;
        dueDay = null;
        break;
    }
  }
  return { status, level, dueDay };
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
