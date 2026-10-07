"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const review_1 = require("../src/review");
const DAY = 24 * 60 * 60 * 1000;
const DAY0 = Date.UTC(2026, 0, 1); // 某个 UTC 自然日 00:00
function day(n) {
    return DAY0 + n * DAY;
}
function ev(eventId, studentId, wordId, occurredAt, kind) {
    return { eventId, studentId, wordId, occurredAt, kind };
}
// 独立参考实现：按规定顺序（occurredAt 升序，同时间按 eventId ASCII 字典序）解释事件。
function referenceState(events) {
    const byId = new Map();
    for (const e of events) {
        if (!byId.has(e.eventId))
            byId.set(e.eventId, e);
    }
    const ordered = [...byId.values()].sort((a, b) => a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    const intervals = [1, 3, 7, 14, 30];
    let status = "inactive";
    let idx = -1;
    let due = 0;
    const dayNum = (ts) => Math.floor(ts / DAY);
    for (const e of ordered) {
        if (status === "mastered")
            break;
        if (e.kind === "incorrect") {
            status = "pending";
            idx = 0;
            due = dayNum(e.occurredAt) + 1;
        }
        else if (e.kind === "correct") {
            if (status === "pending" && dayNum(e.occurredAt) >= due) {
                idx = Math.min(idx + 1, intervals.length - 1);
                due = dayNum(e.occurredAt) + intervals[idx];
            }
        }
        else {
            status = "mastered";
        }
    }
    if (status !== "pending")
        return { status, intervalDays: null, dueAt: null };
    return { status, intervalDays: intervals[idx], dueAt: due * DAY };
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
(0, node_test_1.test)("随机乱序与重复提交：与按序解释结果一致", () => {
    const rand = mulberry32(42);
    const kinds = ["incorrect", "incorrect", "correct", "correct", "correct", "mastered"];
    const pairs = [
        ["s1", "w1"],
        ["s1", "w2"],
        ["s2", "w1"],
    ];
    const allEvents = [];
    let seq = 0;
    for (const [sid, wid] of pairs) {
        const n = 3 + Math.floor(rand() * 12);
        for (let i = 0; i < n; i++) {
            const occurredAt = day(Math.floor(rand() * 40)) + Math.floor(rand() * DAY);
            const kind = kinds[Math.floor(rand() * kinds.length)];
            allEvents.push(ev(`e${seq++}`, sid, wid, occurredAt, kind));
        }
    }
    // 随机乱序，并随机重复提交部分事件
    const shuffled = [...allEvents];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const store = new review_1.WordReviewStore();
    for (const e of shuffled) {
        store.ingest(e);
        if (rand() < 0.3)
            store.ingest(e); // 重复提交
    }
    for (const [sid, wid] of pairs) {
        const expected = referenceState(allEvents.filter((e) => e.studentId === sid && e.wordId === wid));
        strict_1.default.deepEqual(store.getState(sid, wid), expected, `${sid}/${wid}`);
    }
});
(0, node_test_1.test)("同一 eventId 重复提交只生效一次", () => {
    const store = new review_1.WordReviewStore();
    const e = ev("dup", "s", "w", day(0), "incorrect");
    store.ingest(e);
    store.ingest(e);
    store.ingest({ ...e }); // 内容相同的另一个对象
    strict_1.default.deepEqual(store.getState("s", "w"), {
        status: "pending",
        intervalDays: 1,
        dueAt: day(1),
    });
});
(0, node_test_1.test)("未激活时 correct 无效，但保留；补报更早 incorrect 后变为有效推进", () => {
    const store = new review_1.WordReviewStore();
    // 先收到 correct（第 5 天），此时未激活，不生效
    store.ingest(ev("c1", "s", "w", day(5), "correct"));
    strict_1.default.deepEqual(store.getState("s", "w"), { status: "inactive", intervalDays: null, dueAt: null });
    // 补报更早的 incorrect（第 2 天）：到期日为第 3 天，第 5 天的 correct 变为有效
    store.ingest(ev("i1", "s", "w", day(2), "incorrect"));
    strict_1.default.deepEqual(store.getState("s", "w"), {
        status: "pending",
        intervalDays: 3,
        dueAt: day(8),
    });
});
(0, node_test_1.test)("到期日边界：到期日当天的 correct 生效，前一天不生效", () => {
    const store = new review_1.WordReviewStore();
    // incorrect 第 0 天 → 间隔 1 天，到期日第 1 天
    store.ingest(ev("i", "s", "w", day(0) + 3600_000, "incorrect"));
    // 第 0 天晚些时候的 correct：发生日(0) < 到期日(1)，不生效
    store.ingest(ev("c-early", "s", "w", day(0) + 7200_000, "correct"));
    strict_1.default.deepEqual(store.getState("s", "w"), {
        status: "pending",
        intervalDays: 1,
        dueAt: day(1),
    });
    // 第 1 天 00:00 整的 correct：发生日 == 到期日，生效，推进到 3 天
    store.ingest(ev("c-on-due", "s", "w", day(1), "correct"));
    strict_1.default.deepEqual(store.getState("s", "w"), {
        status: "pending",
        intervalDays: 3,
        dueAt: day(4),
    });
});
(0, node_test_1.test)("间隔依次推进 1、3、7、14、30，之后保持 30", () => {
    const store = new review_1.WordReviewStore();
    store.ingest(ev("i", "s", "w", day(0), "incorrect"));
    const expected = [
        [3, 4], // 第 1 天正确 → 间隔 3，到期第 4 天
        [7, 11], // 第 4 天正确 → 间隔 7，到期第 11 天
        [14, 25], // 第 11 天正确 → 间隔 14，到期第 25 天
        [30, 55], // 第 25 天正确 → 间隔 30，到期第 55 天
        [30, 85], // 第 55 天正确 → 保持 30，到期第 85 天
    ];
    let correctDay = 1;
    for (const [interval, due] of expected) {
        store.ingest(ev(`c${correctDay}`, "s", "w", day(correctDay), "correct"));
        strict_1.default.deepEqual(store.getState("s", "w"), {
            status: "pending",
            intervalDays: interval,
            dueAt: day(due),
        });
        correctDay = due;
    }
});
(0, node_test_1.test)("错误重置为 1 天间隔", () => {
    const store = new review_1.WordReviewStore();
    store.ingest(ev("i1", "s", "w", day(0), "incorrect"));
    store.ingest(ev("c1", "s", "w", day(1), "correct")); // 推进到 3 天
    store.ingest(ev("i2", "s", "w", day(10), "incorrect")); // 重置
    strict_1.default.deepEqual(store.getState("s", "w"), {
        status: "pending",
        intervalDays: 1,
        dueAt: day(11),
    });
});
(0, node_test_1.test)("mastered 为永久终态：补报更早或更晚事件都不会重新激活", () => {
    const store = new review_1.WordReviewStore();
    store.ingest(ev("i1", "s", "w", day(0), "incorrect"));
    store.ingest(ev("m", "s", "w", day(5), "mastered"));
    strict_1.default.deepEqual(store.getState("s", "w"), { status: "mastered", intervalDays: null, dueAt: null });
    // 补报更晚的事件
    store.ingest(ev("i2", "s", "w", day(10), "incorrect"));
    store.ingest(ev("c2", "s", "w", day(11), "correct"));
    strict_1.default.deepEqual(store.getState("s", "w"), { status: "mastered", intervalDays: null, dueAt: null });
    // 补报更早（mastered 之前）的事件：参与历史重放，但 mastered 仍是终态
    store.ingest(ev("c0", "s", "w", day(1), "correct"));
    store.ingest(ev("i0", "s", "w", day(2), "incorrect"));
    strict_1.default.deepEqual(store.getState("s", "w"), { status: "mastered", intervalDays: null, dueAt: null });
});
(0, node_test_1.test)("不同学生与词之间相互隔离", () => {
    const store = new review_1.WordReviewStore();
    store.ingest(ev("e1", "s1", "w1", day(0), "incorrect"));
    store.ingest(ev("e2", "s1", "w1", day(1), "correct"));
    store.ingest(ev("e3", "s1", "w2", day(0), "mastered"));
    store.ingest(ev("e4", "s2", "w1", day(0), "incorrect"));
    strict_1.default.deepEqual(store.getState("s1", "w1"), {
        status: "pending",
        intervalDays: 3,
        dueAt: day(4),
    });
    strict_1.default.deepEqual(store.getState("s1", "w2"), { status: "mastered", intervalDays: null, dueAt: null });
    strict_1.default.deepEqual(store.getState("s2", "w1"), {
        status: "pending",
        intervalDays: 1,
        dueAt: day(1),
    });
    strict_1.default.deepEqual(store.getState("s2", "w2"), { status: "inactive", intervalDays: null, dueAt: null });
});
(0, node_test_1.test)("同一 occurredAt 按 eventId ASCII 字典序决定先后", () => {
    const store = new review_1.WordReviewStore();
    // 同一时间：'b' 是 incorrect，'a' 是 mastered；字典序 a 先 → mastered 生效，incorrect 被忽略
    store.ingest(ev("b", "s", "w", day(0), "incorrect"));
    store.ingest(ev("a", "s", "w", day(0), "mastered"));
    strict_1.default.deepEqual(store.getState("s", "w"), { status: "mastered", intervalDays: null, dueAt: null });
});
