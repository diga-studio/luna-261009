"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WordReviewStore = void 0;
const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVALS_DAYS = [1, 3, 7, 14, 30];
function dayOf(utcMs) {
    return Math.floor(utcMs / DAY_MS);
}
class WordReviewStore {
    eventsByPair = new Map();
    ingest(event) {
        const key = pairKey(event.studentId, event.wordId);
        let events = this.eventsByPair.get(key);
        if (events === undefined) {
            events = new Map();
            this.eventsByPair.set(key, events);
        }
        if (!events.has(event.eventId)) {
            events.set(event.eventId, event);
        }
    }
    getState(studentId, wordId) {
        const events = this.eventsByPair.get(pairKey(studentId, wordId));
        if (events === undefined || events.size === 0) {
            return { status: "inactive", intervalDays: null, dueAt: null };
        }
        const ordered = [...events.values()].sort((a, b) => a.occurredAt - b.occurredAt || compareAscii(a.eventId, b.eventId));
        return replay(ordered);
    }
}
exports.WordReviewStore = WordReviewStore;
function pairKey(studentId, wordId) {
    return studentId + " " + wordId;
}
function compareAscii(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function replay(ordered) {
    let status = "inactive";
    let intervalIndex = -1;
    let dueDay = 0;
    for (const event of ordered) {
        if (status === "mastered") {
            break;
        }
        switch (event.kind) {
            case "incorrect":
                status = "pending";
                intervalIndex = 0;
                dueDay = dayOf(event.occurredAt) + INTERVALS_DAYS[0];
                break;
            case "correct":
                if (status === "pending" && dayOf(event.occurredAt) >= dueDay) {
                    intervalIndex = Math.min(intervalIndex + 1, INTERVALS_DAYS.length - 1);
                    dueDay = dayOf(event.occurredAt) + INTERVALS_DAYS[intervalIndex];
                }
                break;
            case "mastered":
                status = "mastered";
                break;
        }
    }
    if (status !== "pending") {
        return { status, intervalDays: null, dueAt: null };
    }
    return {
        status,
        intervalDays: INTERVALS_DAYS[intervalIndex],
        dueAt: dueDay * DAY_MS,
    };
}
