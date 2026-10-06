import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { SmsScheduler } from "../src/index";

function attempts(s: SmsScheduler): Array<{ id: string; at: string; outcome: string }> {
  return s.listAttempts().map((a) => ({
    id: a.messageId,
    at: a.attemptedAt.toISOString(),
    outcome: a.outcome,
  }));
}

test("夏令时切换：7 条不同模板全部成功，第 7 条恰好 24 小时后尝试", () => {
  const s = new SmsScheduler("2026-03-07T13:00:00Z"); // 纽约 08:00 EST
  for (let i = 1; i <= 7; i += 1) {
    s.submit({
      contactId: "vip",
      templateId: `tpl-${i}`,
      scheduledAt: "2026-03-07T13:00:00Z",
      outcomes: ["success"],
    });
  }
  s.advanceTo("2026-03-09T13:00:00Z");

  const got = attempts(s);
  for (let i = 0; i < 6; i += 1) {
    deepEqual(got[i], {
      id: `msg-${i + 1}`,
      at: "2026-03-07T13:00:00.000Z",
      outcome: "success",
    });
  }
  // 2026-03-08 凌晨纽约进入夏令时；第 7 条必须按 UTC 实际经过 24 小时，
  // 即 2026-03-08T13:00:00Z（当地 09:00 EDT，仍在窗口内），不能提前。
  deepEqual(got[6], {
    id: "msg-7",
    at: "2026-03-08T13:00:00.000Z",
    outcome: "success",
  });
  equal(got.length, 7);
});

test("静默窗口：21:00 后禁止尝试，顺延到次日当地 08:00", () => {
  const s = new SmsScheduler("2026-01-09T13:00:00Z");
  // 2026-01-10T02:30:00Z 对应纽约 01-09 21:30 EST，已在禁止时段
  s.submit({
    contactId: "c1",
    templateId: "night",
    scheduledAt: "2026-01-10T02:30:00Z",
    outcomes: ["success"],
  });
  s.advanceTo("2026-01-11T13:00:00Z");
  // 次日 08:00 EST = 13:00Z
  deepEqual(attempts(s), [
    { id: "msg-1", at: "2026-01-10T13:00:00.000Z", outcome: "success" },
  ]);
});

test("静默窗口起点遵循夏令时：3 月 8 日窗口于 12:00Z 打开", () => {
  const s = new SmsScheduler("2026-03-08T05:00:00Z"); // 纽约 00:00 EST，深夜禁发
  s.submit({
    contactId: "c1",
    templateId: "dst",
    scheduledAt: "2026-03-08T05:00:00Z",
    outcomes: ["success"],
  });
  s.advanceTo("2026-03-09T00:00:00Z");
  // 2026-03-08 当天 08:00 已是 EDT（UTC-4），即 12:00Z
  deepEqual(attempts(s), [
    { id: "msg-1", at: "2026-03-08T12:00:00.000Z", outcome: "success" },
  ]);
});

test("被挡住的消息不阻塞其他联系人的可行消息", () => {
  const s = new SmsScheduler("2026-01-09T13:00:00Z");
  s.submit({
    contactId: "c1",
    templateId: "night",
    scheduledAt: "2026-01-10T02:30:00Z", // 静默窗口，须等次日 13:00Z
    outcomes: ["success"],
  });
  s.submit({
    contactId: "c2",
    templateId: "day",
    scheduledAt: "2026-01-09T14:00:00Z", // 纽约 09:00，可立即发
    outcomes: ["success"],
  });
  s.advanceTo("2026-01-10T13:00:00Z");
  deepEqual(attempts(s), [
    { id: "msg-2", at: "2026-01-09T14:00:00.000Z", outcome: "success" },
    { id: "msg-1", at: "2026-01-10T13:00:00.000Z", outcome: "success" },
  ]);
});

test("三次失败后标记耗尽，不再尝试", () => {
  const s = new SmsScheduler("2026-01-10T13:00:00Z");
  s.submit({
    contactId: "c1",
    templateId: "risky",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["failure", "failure", "failure"],
  });
  s.advanceTo("2026-01-20T13:00:00Z");
  deepEqual(attempts(s), [
    { id: "msg-1", at: "2026-01-10T13:00:00.000Z", outcome: "failure" },
    { id: "msg-1", at: "2026-01-10T13:01:00.000Z", outcome: "failure" },
    { id: "msg-1", at: "2026-01-10T13:03:00.000Z", outcome: "failure" },
  ]);
  equal(s.getMessage("msg-1")?.status, "exhausted");
});

test("重试不受同模板 4 小时去重限制", () => {
  const s = new SmsScheduler("2026-01-10T13:00:00Z");
  s.submit({
    contactId: "c1",
    templateId: "promo",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["failure", "success"],
  });
  s.submit({
    contactId: "c1",
    templateId: "promo",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["success"],
  });
  s.advanceTo("2026-01-11T13:00:00Z");
  deepEqual(attempts(s), [
    { id: "msg-1", at: "2026-01-10T13:00:00.000Z", outcome: "failure" },
    { id: "msg-1", at: "2026-01-10T13:01:00.000Z", outcome: "success" }, // 重试不被去重拦截
    { id: "msg-2", at: "2026-01-10T17:00:00.000Z", outcome: "success" }, // 首次尝试等 4 小时
  ]);
});

test("排序：重试按上次尝试加等待时长参与竞争", () => {
  const s = new SmsScheduler("2026-01-10T13:00:00Z");
  s.submit({
    contactId: "cA",
    templateId: "tA",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["failure", "success"],
  });
  s.submit({
    contactId: "cB",
    templateId: "tB",
    scheduledAt: "2026-01-10T13:00:30Z",
    outcomes: ["success"],
  });
  s.advanceTo("2026-01-10T14:00:00Z");
  deepEqual(attempts(s), [
    { id: "msg-1", at: "2026-01-10T13:00:00.000Z", outcome: "failure" },
    { id: "msg-2", at: "2026-01-10T13:00:30.000Z", outcome: "success" },
    { id: "msg-1", at: "2026-01-10T13:01:00.000Z", outcome: "success" },
  ]);
});

test("滚动 24 小时额度：重试与新消息共同竞争 6 次额度", () => {
  const s = new SmsScheduler("2026-01-10T13:00:00Z");
  s.submit({
    contactId: "c1",
    templateId: "A",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["failure", "failure", "failure"],
  });
  s.submit({
    contactId: "c1",
    templateId: "B",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["failure", "success"],
  });
  s.submit({
    contactId: "c1",
    templateId: "C",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["success"],
  });
  s.submit({
    contactId: "c1",
    templateId: "D",
    scheduledAt: "2026-01-10T13:00:00Z",
    outcomes: ["success"],
  });
  s.advanceTo("2026-01-12T13:00:00Z");

  // 13:00 四条首次尝试 + 13:01 两条重试 = 6 次，额度恰好用完；
  // msg-1 的第三次尝试（本应在 13:03）被额度挡住，
  // 须等最早一次尝试（13:00Z）恰好满 24 小时才释放。
  deepEqual(attempts(s), [
    { id: "msg-1", at: "2026-01-10T13:00:00.000Z", outcome: "failure" },
    { id: "msg-2", at: "2026-01-10T13:00:00.000Z", outcome: "failure" },
    { id: "msg-3", at: "2026-01-10T13:00:00.000Z", outcome: "success" },
    { id: "msg-4", at: "2026-01-10T13:00:00.000Z", outcome: "success" },
    { id: "msg-1", at: "2026-01-10T13:01:00.000Z", outcome: "failure" },
    { id: "msg-2", at: "2026-01-10T13:01:00.000Z", outcome: "success" },
    { id: "msg-1", at: "2026-01-11T13:00:00.000Z", outcome: "failure" },
  ]);
  equal(s.getMessage("msg-1")?.status, "exhausted");
});
