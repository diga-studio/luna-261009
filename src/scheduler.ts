import {
  AttemptRecord,
  MessageView,
  SubmitMessageInput,
  UtcTimestamp,
} from "./types";
import { nextAllowedTime } from "./timezone";

const TIME_ZONE = "America/New_York";
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 21;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000;
/** Retry wait after the n-th failed attempt (1-based), in ms. */
const RETRY_WAITS_MS = [60 * 1000, 120 * 1000];

interface Attempt {
  timeMs: number;
  success: boolean;
}

interface Message {
  id: number;
  contactId: string;
  templateId: string;
  scheduledAtMs: number;
  outcomes: boolean[];
  attempts: Attempt[];
  status: "pending" | "delivered" | "exhausted";
}

function parseUtc(ts: UtcTimestamp, field: string): number {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid UTC timestamp for ${field}: ${ts}`);
  }
  return ms;
}

function toIso(ms: number): UtcTimestamp {
  return new Date(ms).toISOString();
}

export class SmsScheduler {
  private nowMs: number;
  private messages: Message[] = [];
  private attemptLog: AttemptRecord[] = [];

  constructor(startUtc: UtcTimestamp) {
    this.nowMs = parseUtc(startUtc, "startUtc");
  }

  /** Registers a message; nothing is sent until advance() is called. */
  submit(input: SubmitMessageInput): number {
    if (!input.contactId) throw new Error("contactId is required");
    if (!input.templateId) throw new Error("templateId is required");
    if (!Array.isArray(input.outcomes) || input.outcomes.length < 1 ||
        input.outcomes.length > MAX_ATTEMPTS) {
      throw new Error("outcomes must contain 1 to 3 entries");
    }
    const scheduledAtMs = parseUtc(input.scheduledAt, "scheduledAt");
    const msg: Message = {
      id: this.messages.length + 1,
      contactId: input.contactId,
      templateId: input.templateId,
      scheduledAtMs,
      outcomes: input.outcomes.map(Boolean),
      attempts: [],
      status: "pending",
    };
    this.messages.push(msg);
    return msg.id;
  }

  /** Advances the simulated clock, executing every attempt that becomes
   *  eligible up to and including targetUtc. */
  advance(targetUtc: UtcTimestamp): void {
    const targetMs = parseUtc(targetUtc, "targetUtc");
    if (targetMs < this.nowMs) {
      throw new Error("Cannot advance backwards in time");
    }
    for (;;) {
      const pending = this.messages.filter((m) => m.status === "pending");
      if (pending.length === 0) break;
      const readyNow = pending.filter(
        (m) => this.eligibleAt(m, this.nowMs) <= this.nowMs
      );
      if (readyNow.length === 0) {
        let next = Infinity;
        for (const m of pending) {
          const t = this.eligibleAt(m, this.nowMs);
          if (t < next) next = t;
        }
        if (next > targetMs) break;
        this.nowMs = next;
        continue;
      }
      readyNow.sort((a, b) => {
        const d = this.effectiveTimeMs(a) - this.effectiveTimeMs(b);
        return d !== 0 ? d : a.id - b.id;
      });
      this.executeAttempt(readyNow[0]);
    }
    this.nowMs = targetMs;
  }

  /** All attempt records in execution order. */
  getAttempts(): AttemptRecord[] {
    return this.attemptLog.slice();
  }

  /** Per-message view including status and attempts. */
  getMessages(): MessageView[] {
    return this.messages.map((m) => ({
      messageId: m.id,
      contactId: m.contactId,
      templateId: m.templateId,
      scheduledAt: toIso(m.scheduledAtMs),
      status: m.status,
      attempts: m.attempts.map((a, i) => ({
        messageId: m.id,
        contactId: m.contactId,
        templateId: m.templateId,
        attemptNumber: i + 1,
        attemptedAt: toIso(a.timeMs),
        success: a.success,
      })),
    }));
  }

  /** Current simulated UTC time. */
  now(): UtcTimestamp {
    return toIso(this.nowMs);
  }

  /** Earliest desired time for the next attempt, before restrictions. */
  private effectiveTimeMs(m: Message): number {
    const done = m.attempts.length;
    if (done === 0) return m.scheduledAtMs;
    const wait = RETRY_WAITS_MS[Math.min(done, RETRY_WAITS_MS.length) - 1];
    return m.attempts[done - 1].timeMs + wait;
  }

  /**
   * Earliest time >= fromMs at which the message's next attempt satisfies
   * the quiet window, the rolling-24h rate limit, the 4h same-template
   * dedup and the retry wait. All constraints are monotonic in t, so a
   * single max-plus-window-shift is exact.
   */
  private eligibleAt(m: Message, fromMs: number): number {
    let t = Math.max(fromMs, this.effectiveTimeMs(m));

    // Rolling 24h per-contact rate limit: attempts exactly 24h old no
    // longer count, so only attempts strictly inside (t-24h, t] count.
    const contactTimes = this.contactAttemptTimes(m.contactId);
    const cutoff = t - RATE_LIMIT_WINDOW_MS;
    let count = 0;
    for (const time of contactTimes) {
      if (time > cutoff && time <= t) count++;
    }
    if (count >= RATE_LIMIT_MAX) {
      t = contactTimes[contactTimes.length - RATE_LIMIT_MAX] +
        RATE_LIMIT_WINDOW_MS;
    }

    // 4h dedup between first attempts of same contact+template messages.
    if (m.attempts.length === 0) {
      for (const other of this.messages) {
        if (other.id === m.id) continue;
        if (other.contactId !== m.contactId) continue;
        if (other.templateId !== m.templateId) continue;
        if (other.attempts.length > 0) {
          const earliest = other.attempts[0].timeMs + DEDUP_WINDOW_MS;
          if (earliest > t) t = earliest;
        }
      }
    }

    return nextAllowedTime(t, TIME_ZONE, WINDOW_START_HOUR, WINDOW_END_HOUR);
  }

  private contactAttemptTimes(contactId: string): number[] {
    const times: number[] = [];
    for (const m of this.messages) {
      if (m.contactId !== contactId) continue;
      for (const a of m.attempts) times.push(a.timeMs);
    }
    times.sort((a, b) => a - b);
    return times;
  }

  private executeAttempt(m: Message): void {
    const attemptNumber = m.attempts.length + 1;
    const preset = m.outcomes[attemptNumber - 1];
    const success = preset === undefined ? false : preset;
    m.attempts.push({ timeMs: this.nowMs, success });
    if (success) {
      m.status = "delivered";
    } else if (attemptNumber >= MAX_ATTEMPTS) {
      m.status = "exhausted";
    }
    this.attemptLog.push({
      messageId: m.id,
      contactId: m.contactId,
      templateId: m.templateId,
      attemptNumber,
      attemptedAt: toIso(this.nowMs),
      success,
    });
  }
}
