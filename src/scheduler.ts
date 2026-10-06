import { isWithinSendingWindow, nextWindowStartMs } from "./timezone";
import type {
  AttemptOutcome,
  AttemptRecord,
  MessageInput,
  MessageStatus,
  MessageView,
} from "./types";

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [60_000, 120_000]; // 第 1、2 次失败后的最小等待
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_ROLLING_WINDOW = 6;
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000;

interface InternalMessage {
  id: string;
  contactId: string;
  templateId: string;
  scheduledAtMs: number;
  outcomes: AttemptOutcome[];
  attempts: AttemptRecord[];
  status: MessageStatus;
  submitSeq: number;
}

function toMs(value: string | Date, field: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} 不是合法的时间: ${String(value)}`);
  }
  return ms;
}

/**
 * 离线短信投递排程器。
 * 状态全部保存在内存；时间通过 advanceTo 推进，不依赖真实时钟。
 */
export class SmsScheduler {
  private nowMs: number;
  private seq = 0;
  private readonly messages: InternalMessage[] = [];
  private readonly attemptLog: AttemptRecord[] = [];

  constructor(startUtc: string | Date) {
    this.nowMs = toMs(startUtc, "startUtc");
  }

  /** 提交消息（仅登记，不执行）。返回消息 id。 */
  submit(message: MessageInput): string {
    if (!message || typeof message.contactId !== "string" || !message.contactId) {
      throw new Error("contactId 不能为空");
    }
    if (typeof message.templateId !== "string" || !message.templateId) {
      throw new Error("templateId 不能为空");
    }
    if (
      !Array.isArray(message.outcomes) ||
      message.outcomes.length < 1 ||
      message.outcomes.length > MAX_ATTEMPTS
    ) {
      throw new Error(`outcomes 必须包含 1 到 ${MAX_ATTEMPTS} 个预设结果`);
    }
    for (const o of message.outcomes) {
      if (o !== "success" && o !== "failure") {
        throw new Error(`非法的预设结果: ${String(o)}`);
      }
    }
    this.seq += 1;
    const id = `msg-${this.seq}`;
    this.messages.push({
      id,
      contactId: message.contactId,
      templateId: message.templateId,
      scheduledAtMs: toMs(message.scheduledAt, "scheduledAt"),
      outcomes: [...message.outcomes],
      attempts: [],
      status: "pending",
      submitSeq: this.seq,
    });
    return id;
  }

  /** 推进模拟时钟到目标 UTC 时刻（含该时刻），期间执行所有可行的尝试。 */
  advanceTo(targetUtc: string | Date): void {
    const targetMs = toMs(targetUtc, "targetUtc");
    if (targetMs < this.nowMs) {
      throw new Error("模拟时钟不能倒退");
    }
    for (;;) {
      const next = this.pickNext(targetMs);
      if (!next) break;
      this.executeAttempt(next.message, next.timeMs);
      this.nowMs = next.timeMs;
    }
    this.nowMs = targetMs;
  }

  /** 查看某条消息的状态与尝试记录。 */
  getMessage(messageId: string): MessageView | undefined {
    const m = this.messages.find((x) => x.id === messageId);
    return m ? toView(m) : undefined;
  }

  /** 查看全部消息（按提交顺序）。 */
  listMessages(): MessageView[] {
    return this.messages.map(toView);
  }

  /** 查看全部尝试记录（按发生顺序）。 */
  listAttempts(): AttemptRecord[] {
    return this.attemptLog.map((a) => ({ ...a, attemptedAt: new Date(a.attemptedAt) }));
  }

  /**
   * 选出下一条可执行的消息及其执行时刻。
   * 返回 null 表示在 limitMs 之前（含）没有任何消息能满足全部限制。
   */
  private pickNext(limitMs: number): { message: InternalMessage; timeMs: number } | null {
    let best: { message: InternalMessage; timeMs: number; baseMs: number } | null = null;
    for (const m of this.messages) {
      if (m.status !== "pending") continue;
      const baseMs = this.baseTimeMs(m);
      const timeMs = this.eligibleTimeMs(m, baseMs);
      if (timeMs > limitMs) continue;
      if (
        !best ||
        timeMs < best.timeMs ||
        (timeMs === best.timeMs &&
          (baseMs < best.baseMs ||
            (baseMs === best.baseMs && m.submitSeq < best.message.submitSeq)))
      ) {
        best = { message: m, timeMs, baseMs };
      }
    }
    return best ? { message: best.message, timeMs: best.timeMs } : null;
  }

  /** 本次尝试的“最早预约时间”：首次用原预约时间，重试用上次实际尝试时间加等待。 */
  private baseTimeMs(m: InternalMessage): number {
    if (m.attempts.length === 0) return m.scheduledAtMs;
    const last = m.attempts[m.attempts.length - 1];
    const backoff = RETRY_BACKOFF_MS[Math.min(m.attempts.length - 1, RETRY_BACKOFF_MS.length - 1)];
    return last.attemptedAt.getTime() + backoff;
  }

  /**
   * 在 baseMs 基础上叠加静默窗口、滚动 24 小时额度、同模板 4 小时去重，
   * 求出该消息下一次尝试的最早可行 UTC 毫秒。
   */
  private eligibleTimeMs(m: InternalMessage, baseMs: number): number {
    let t = Math.max(baseMs, this.nowMs);
    for (;;) {
      let next = t;
      if (!isWithinSendingWindow(next)) {
        next = nextWindowStartMs(next);
      }
      next = Math.max(next, this.quotaReleaseMs(m.contactId, next));
      if (m.attempts.length === 0) {
        next = Math.max(next, this.dedupReleaseMs(m, next));
      }
      if (next === t) return t;
      t = next;
    }
  }

  /** 滚动 24 小时额度：返回该联系人在 notBeforeMs 之后最早不再超限的时刻。 */
  private quotaReleaseMs(contactId: string, notBeforeMs: number): number {
    const times = this.contactAttemptTimesMs(contactId);
    if (times.length < MAX_ATTEMPTS_PER_ROLLING_WINDOW) return notBeforeMs;
    // 第 6 新的尝试恰好满 24 小时后，额度才释放（恰好 24 小时前不再占额度）。
    const sixthNewest = times[times.length - MAX_ATTEMPTS_PER_ROLLING_WINDOW];
    return Math.max(notBeforeMs, sixthNewest + ROLLING_WINDOW_MS);
  }

  /** 同联系人同模板：首次尝试须与其他消息的首次尝试间隔至少 4 小时。 */
  private dedupReleaseMs(m: InternalMessage, notBeforeMs: number): number {
    let release = notBeforeMs;
    for (const other of this.messages) {
      if (other.id === m.id) continue;
      if (other.contactId !== m.contactId || other.templateId !== m.templateId) continue;
      const first = other.attempts[0];
      if (!first) continue;
      release = Math.max(release, first.attemptedAt.getTime() + DEDUP_WINDOW_MS);
    }
    return release;
  }

  private contactAttemptTimesMs(contactId: string): number[] {
    const times: number[] = [];
    for (const m of this.messages) {
      if (m.contactId !== contactId) continue;
      for (const a of m.attempts) times.push(a.attemptedAt.getTime());
    }
    times.sort((a, b) => a - b);
    return times;
  }

  private executeAttempt(m: InternalMessage, timeMs: number): void {
    const attemptNumber = m.attempts.length + 1;
    // 预设结果不足时，超出部分按失败处理（继续占用额度并触发重试/耗尽）。
    const outcome: AttemptOutcome = m.outcomes[attemptNumber - 1] ?? "failure";
    const record: AttemptRecord = {
      messageId: m.id,
      contactId: m.contactId,
      templateId: m.templateId,
      attemptNumber,
      attemptedAt: new Date(timeMs),
      outcome,
    };
    m.attempts.push(record);
    this.attemptLog.push(record);
    if (outcome === "success") {
      m.status = "delivered";
    } else if (attemptNumber >= MAX_ATTEMPTS) {
      m.status = "exhausted";
    }
  }
}

function toView(m: InternalMessage): MessageView {
  return {
    id: m.id,
    contactId: m.contactId,
    templateId: m.templateId,
    scheduledAt: new Date(m.scheduledAtMs),
    status: m.status,
    attempts: m.attempts.map((a) => ({ ...a, attemptedAt: new Date(a.attemptedAt) })),
  };
}
