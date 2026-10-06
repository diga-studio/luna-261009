import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { SmsScheduler } from "../src/index";

const START = "2026-01-10T13:00:00Z"; // 纽约 08:00 EST，窗口刚打开

interface MixedExpectation {
  messageId: string;
  attemptedAt: string;
  outcome: string;
}

function submitMixed(s: SmsScheduler): void {
  // m1：失败、失败、成功 —— 覆盖重试退避 60s / 120s
  s.submit({
    contactId: "c1",
    templateId: "promo",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["failure", "failure", "success"],
  });
  // m2：与 m1 同模板，首次尝试须等 m1 首次尝试后 4 小时
  s.submit({
    contactId: "c1",
    templateId: "promo",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["success"],
  });
  // m3：不同模板，不受去重限制
  s.submit({
    contactId: "c1",
    templateId: "order",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["success"],
  });
}

const MIXED_EXPECTED: MixedExpectation[] = [
  { messageId: "msg-1", attemptedAt: "2026-01-10T13:00:00.000Z", outcome: "failure" },
  { messageId: "msg-3", attemptedAt: "2026-01-10T13:00:00.000Z", outcome: "success" },
  { messageId: "msg-1", attemptedAt: "2026-01-10T13:01:00.000Z", outcome: "failure" },
  { messageId: "msg-1", attemptedAt: "2026-01-10T13:03:00.000Z", outcome: "success" },
  { messageId: "msg-2", attemptedAt: "2026-01-10T17:00:00.000Z", outcome: "success" },
];

function attemptSummary(s: SmsScheduler): MixedExpectation[] {
  return s.listAttempts().map((a) => ({
    messageId: a.messageId,
    attemptedAt: a.attemptedAt.toISOString(),
    outcome: a.outcome,
  }));
}

test("混合场景：重试退避、同模板去重、不同模板并行", () => {
  const s = new SmsScheduler(START);
  submitMixed(s);
  s.advanceTo("2026-01-11T13:00:00Z");

  deepEqual(attemptSummary(s), MIXED_EXPECTED);
  equal(s.getMessage("msg-1")?.status, "delivered");
  equal(s.getMessage("msg-2")?.status, "delivered");
  equal(s.getMessage("msg-3")?.status, "delivered");
  equal(s.getMessage("msg-1")?.attempts.length, 3);
});

test("分段推进与一次推进结果完全一致", () => {
  const once = new SmsScheduler(START);
  submitMixed(once);
  once.advanceTo("2026-01-11T13:00:00Z");

  const segmented = new SmsScheduler(START);
  submitMixed(segmented);
  segmented.advanceTo("2026-01-10T13:02:00Z");
  segmented.advanceTo("2026-01-10T15:00:00Z");
  segmented.advanceTo("2026-01-10T17:30:00Z");
  segmented.advanceTo("2026-01-11T13:00:00Z");

  deepEqual(attemptSummary(segmented), attemptSummary(once));
  deepEqual(
    segmented.listMessages().map((m) => m.status),
    once.listMessages().map((m) => m.status),
  );
});
