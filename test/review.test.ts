import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { WordReview } from "../src/review";
import { ReviewEvent, ReviewState } from "../src/types";

const DAY = 24 * 60 * 60 * 1000;
const INTERVALS = [1, 3, 7, 14, 30];

/** 独立参照实现：按规定顺序（occurredAt 升序，同时间按 eventId ASCII 序）解释事件。 */
function referenceState(
  events: ReviewEvent[],
  studentId: string,
  wordId: string
): ReviewState {
  const seen = new Set<string>();
  const sorted = events
    .filter((e) => e.studentId === studentId && e.wordId === wordId)
    .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
    .sort(
      (a, b) =>
        a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)
    );
  let status: "inactive" | "pending" | "mastered" = "inactive";
  let level = 0;
  let dueDay: number | null = null;
  for (const e of sorted) {
    if (status === "mastered") break;
    const day = Math.floor(e.occurredAt / DAY);
    if (e.kind === "incorrect") {
      status = "pending";
      level = 0;
      dueDay = day + 1;
    } else if (e.kind === "correct") {
      if (status === "pending" && dueDay !== null && day >= dueDay) {
        level = Math.min(level + 1, INTERVALS.length - 1);
        dueDay = day + INTERVALS[level];
      }
    } else {
      status = "mastered";
    }
  }
  if (status !== "pending") return { status, intervalDays: null, dueAt: null };
  return { status, intervalDays: INTERVALS[level], dueAt: dueDay! * DAY };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("未激活：无任何事件或只有 correct 时保持 inactive", () => {
  const review = new WordReview();
  deepEqual(review.getState("s1", "w1"), {
    status: "inactive",
    intervalDays: null,
    dueAt: null,
  });
  review.ingest({ eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: 5 * DAY, kind: "correct" });
  equal(review.getState("s1", "w1").status, "inactive");
});

test("incorrect 激活为 1 天间隔，到期日为发生日 +1 天", () => {
  const review = new WordReview();
  const t = 10 * DAY + 1234; // 当天内任意毫秒
  review.ingest({ eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: t, kind: "incorrect" });
  deepEqual(review.getState("s1", "w1"), {
    status: "pending",
    intervalDays: 1,
    dueAt: 11 * DAY,
  });
});

test("同一 eventId 重复提交只生效一次", () => {
  const review = new WordReview();
  const e: ReviewEvent = { eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" };
  review.ingest(e);
  review.ingest(e);
  review.ingest({ ...e });
  deepEqual(review.getState("s1", "w1"), { status: "pending", intervalDays: 1, dueAt: DAY });
});

test("间隔依次推进 1、3、7、14、30，之后保持 30", () => {
  const review = new WordReview();
  review.ingest({ eventId: "e0", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  let due = 1 * DAY;
  const expected = [3, 7, 14, 30, 30, 30];
  for (let i = 0; i < expected.length; i++) {
    review.ingest({ eventId: `c${i}`, studentId: "s1", wordId: "w1", occurredAt: due, kind: "correct" });
    const state = review.getState("s1", "w1");
    equal(state.intervalDays, expected[i]);
    due += expected[i] * DAY;
    equal(state.dueAt, due);
  }
});

test("到期日边界：到期日当天 correct 生效，前一天不生效", () => {
  const review = new WordReview();
  review.ingest({ eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  // 到期日为第 1 天；第 0 天的 correct 不生效
  review.ingest({ eventId: "e2", studentId: "s1", wordId: "w1", occurredAt: DAY - 1, kind: "correct" });
  deepEqual(review.getState("s1", "w1"), { status: "pending", intervalDays: 1, dueAt: DAY });
  // 到期日当天（第 1 天）的 correct 生效，推进到 3 天
  review.ingest({ eventId: "e3", studentId: "s1", wordId: "w1", occurredAt: DAY, kind: "correct" });
  deepEqual(review.getState("s1", "w1"), { status: "pending", intervalDays: 3, dueAt: 4 * DAY });
});

test("先收到未激活时的 correct 保留，补报更早 incorrect 后变为有效推进", () => {
  const review = new WordReview();
  // correct 先到，此时未激活，不生效
  review.ingest({ eventId: "e2", studentId: "s1", wordId: "w1", occurredAt: 5 * DAY, kind: "correct" });
  equal(review.getState("s1", "w1").status, "inactive");
  // 补报更早的 incorrect：correct 变为有效，推进到 3 天，到期日 = 第5天 + 3天
  review.ingest({ eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: 2 * DAY, kind: "incorrect" });
  deepEqual(review.getState("s1", "w1"), {
    status: "pending",
    intervalDays: 3,
    dueAt: 8 * DAY,
  });
});

test("mastered 为永久终态：补报更早或更晚事件都不得重新激活", () => {
  const review = new WordReview();
  review.ingest({ eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  review.ingest({ eventId: "e2", studentId: "s1", wordId: "w1", occurredAt: 2 * DAY, kind: "mastered" });
  deepEqual(review.getState("s1", "w1"), { status: "mastered", intervalDays: null, dueAt: null });
  // 更晚的 incorrect / correct 无效
  review.ingest({ eventId: "e3", studentId: "s1", wordId: "w1", occurredAt: 3 * DAY, kind: "incorrect" });
  review.ingest({ eventId: "e4", studentId: "s1", wordId: "w1", occurredAt: 4 * DAY, kind: "correct" });
  equal(review.getState("s1", "w1").status, "mastered");
  // 补报更早（mastered 之前）的事件也不改变终态
  review.ingest({ eventId: "e5", studentId: "s1", wordId: "w1", occurredAt: DAY, kind: "correct" });
  review.ingest({ eventId: "e6", studentId: "s1", wordId: "w1", occurredAt: DAY, kind: "incorrect" });
  equal(review.getState("s1", "w1").status, "mastered");
});

test("同一 occurredAt 按 eventId ASCII 字典序排列", () => {
  const review = new WordReview();
  // 同一时刻：eventId "b" 是 incorrect，"a" 是 mastered；按字典序 a 先执行
  review.ingest({ eventId: "b", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  review.ingest({ eventId: "a", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "mastered" });
  equal(review.getState("s1", "w1").status, "mastered");
  // 反过来：mastered 的 eventId 更大时，incorrect 先执行但随后被 mastered 覆盖
  const review2 = new WordReview();
  review2.ingest({ eventId: "a", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  review2.ingest({ eventId: "b", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "correct" });
  // a(incorrect) 先，到期日第1天；b(correct) 第0天 < 到期日，不生效
  deepEqual(review2.getState("s1", "w1"), { status: "pending", intervalDays: 1, dueAt: DAY });
});

test("不同学生与词之间相互隔离", () => {
  const review = new WordReview();
  review.ingest({ eventId: "e1", studentId: "s1", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  review.ingest({ eventId: "e2", studentId: "s1", wordId: "w2", occurredAt: 0, kind: "mastered" });
  review.ingest({ eventId: "e3", studentId: "s2", wordId: "w1", occurredAt: 0, kind: "incorrect" });
  review.ingest({ eventId: "e4", studentId: "s2", wordId: "w1", occurredAt: DAY, kind: "correct" });
  deepEqual(review.getState("s1", "w1"), { status: "pending", intervalDays: 1, dueAt: DAY });
  deepEqual(review.getState("s1", "w2"), { status: "mastered", intervalDays: null, dueAt: null });
  deepEqual(review.getState("s2", "w1"), { status: "pending", intervalDays: 3, dueAt: 4 * DAY });
  deepEqual(review.getState("s2", "w2"), { status: "inactive", intervalDays: null, dueAt: null });
});

test("随机乱序与重复提交：任意到达顺序产生同一投影", () => {
  const students = ["s1", "s2", "s3"];
  const words = ["w1", "w2", "w3", "w4"];
  const kinds: ReviewEvent["kind"][] = ["incorrect", "correct", "correct", "mastered"];
  for (let seed = 1; seed <= 40; seed++) {
    const rand = mulberry32(seed);
    // 生成小数据随机事件集合（含相同 occurredAt 触发字典序比较）
    const events: ReviewEvent[] = [];
    const n = 5 + Math.floor(rand() * 20);
    for (let i = 0; i < n; i++) {
      events.push({
        eventId: `e${i}-${Math.floor(rand() * 3)}${i}`,
        studentId: students[Math.floor(rand() * students.length)],
        wordId: words[Math.floor(rand() * words.length)],
        occurredAt: Math.floor(rand() * 60) * DAY + Math.floor(rand() * 2) * 3600000,
        kind: kinds[Math.floor(rand() * kinds.length)],
      });
    }
    // 加入重复提交
    const withDupes = [...events];
    for (let i = 0; i < events.length / 2; i++) {
      withDupes.push(events[Math.floor(rand() * events.length)]);
    }
    const review = new WordReview();
    for (const e of shuffle(withDupes, rand)) review.ingest(e);
    for (const s of students) {
      for (const w of words) {
        deepEqual(
          review.getState(s, w),
          referenceState(events, s, w),
          `seed=${seed} ${s}/${w}`
        );
      }
    }
  }
});
