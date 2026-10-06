import test from "node:test";
import assert from "node:assert/strict";
import {
  DispatchService,
  INVITATION_TTL_MS,
  openDatabase,
  Target,
  TaskView,
} from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = 1_700_000_000_000;

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `key-${keyCounter}`;
}

function makeService(): DispatchService {
  return new DispatchService(openDatabase(":memory:"));
}

function student(id: string): Target {
  return { type: "student", id };
}

function createAccepted(
  svc: DispatchService,
  staffId: string,
  target: Target,
  serviceTime: number,
  now: number,
): TaskView {
  const task = svc.createTask(
    { idempotencyKey: nextKey(), target, serviceTime, candidates: [staffId] },
    now,
  );
  assert.equal(task.status, "inviting");
  assert.ok(task.currentInvitation);
  const result = svc.acceptInvitation(task.currentInvitation!.id, now);
  assert.ok(result.ok);
  return result.task;
}

test("乱序补录：24小时窗口横跨新增预约时刻", () => {
  const svc = makeService();
  const now = BASE - 30 * DAY;
  // 乱序录入：23h、0h、10h（不同目标）
  for (const offset of [23 * HOUR, 0, 10 * HOUR]) {
    createAccepted(svc, "staff-A", student(`s-${offset}`), BASE + offset, now);
  }
  // 新增 12h：窗口 [0h,24h) 内将有 0/10/12/23h 共 4 份 → 拒绝
  const t12 = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-new-12"), serviceTime: BASE + 12 * HOUR, candidates: ["staff-A"] },
    now,
  );
  assert.equal(t12.status, "unassignable");
  assert.equal(t12.currentInvitation, null);
  // 新增 24h-1ms：仍在窗口 [0h,24h) 内 → 拒绝
  const tAlmost = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-new-almost"), serviceTime: BASE + 24 * HOUR - 1, candidates: ["staff-A"] },
    now,
  );
  assert.equal(tAlmost.status, "unassignable");
  // 新增 24h：窗口 [0h,24h) 不含 24h → 允许
  const t24 = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-new-24"), serviceTime: BASE + 24 * HOUR, candidates: ["staff-A"] },
    now,
  );
  assert.equal(t24.status, "inviting");
  assert.equal(t24.currentInvitation?.staffId, "staff-A");
  svc.close();
});

test("同一目标相隔14天允许，少1毫秒拒绝；同号学生与班级不是同一目标", () => {
  const svc = makeService();
  const now = BASE - 30 * DAY;
  createAccepted(svc, "staff-B", student("s-1"), BASE, now);
  createAccepted(svc, "staff-C", student("s-1"), BASE, now);
  // 恰好相隔 14 天 → 允许
  const ok14 = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-1"), serviceTime: BASE + 14 * DAY, candidates: ["staff-B"] },
    now,
  );
  assert.equal(ok14.status, "inviting");
  // 相隔 14 天少 1 毫秒 → 拒绝
  const almost = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-1"), serviceTime: BASE + 14 * DAY - 1, candidates: ["staff-C"] },
    now,
  );
  assert.equal(almost.status, "unassignable");
  // 同号的学生与班级是不同目标
  const otherType = svc.createTask(
    { idempotencyKey: nextKey(), target: { type: "class", id: "s-1" }, serviceTime: BASE + HOUR, candidates: ["staff-B"] },
    now,
  );
  assert.equal(otherType.status, "inviting");
  svc.close();
});

test("同一幂等键重试返回现有任务，不重新派发、不增加占额", () => {
  const svc = makeService();
  const now = BASE;
  const first = svc.createTask(
    { idempotencyKey: "dup-key", target: student("s-1"), serviceTime: BASE + DAY, candidates: ["staff-A"] },
    now,
  );
  assert.equal(first.status, "inviting");
  // 相同键、不同参数重试
  const again = svc.createTask(
    { idempotencyKey: "dup-key", target: student("s-other"), serviceTime: BASE + 2 * DAY, candidates: ["staff-A", "staff-B"] },
    now + 1000,
  );
  assert.equal(again.id, first.id);
  assert.equal(again.serviceTime, first.serviceTime);
  assert.equal(again.currentInvitation?.id, first.currentInvitation?.id);
  // 占额未翻倍：staff-A 仅持有 BASE+DAY 一份，再接受两份后达到 3 份上限
  createAccepted(svc, "staff-A", student("s-2"), BASE + DAY + HOUR, now);
  createAccepted(svc, "staff-A", student("s-3"), BASE + DAY + 2 * HOUR, now);
  const fourth = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-4"), serviceTime: BASE + DAY + 3 * HOUR, candidates: ["staff-A"] },
    now,
  );
  assert.equal(fourth.status, "unassignable");
  svc.close();
});

test("邀请到期即失效，到期处理按原顺序改派并重新计时", () => {
  const svc = makeService();
  const now = BASE;
  const task = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-1"), serviceTime: BASE + DAY, candidates: ["staff-A", "staff-B"] },
    now,
  );
  const invA = task.currentInvitation!;
  assert.equal(invA.staffId, "staff-A");
  assert.equal(invA.expiresAt, now + INVITATION_TTL_MS);
  // 到达截止时刻即失效：恰好在截止时刻接受 → 拒绝
  const late = svc.acceptInvitation(invA.id, now + INVITATION_TTL_MS);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.reason, "invitation_expired");
  // 到期处理：A 的邀请失效，改派 B，期限从处理时刻起算
  const processed = svc.processExpiredInvitations(now + INVITATION_TTL_MS);
  assert.deepEqual(processed.expiredInvitationIds, [invA.id]);
  const invB = processed.tasks[0]!.currentInvitation!;
  assert.equal(invB.staffId, "staff-B");
  assert.equal(invB.issuedAt, now + INVITATION_TTL_MS);
  assert.equal(invB.expiresAt, now + 2 * INVITATION_TTL_MS);
  // 失效邀请的迟到接受不能覆盖新邀请
  const lateAgain = svc.acceptInvitation(invA.id, now + INVITATION_TTL_MS + 1000);
  assert.equal(lateAgain.ok, false);
  assert.equal(svc.getTask(task.id)!.currentInvitation?.id, invB.id);
  // 首次接受当前邀请成功；重复接受保持成功；已接受不再受期限影响
  const accept = svc.acceptInvitation(invB.id, now + INVITATION_TTL_MS + 1000);
  assert.ok(accept.ok);
  const acceptAgain = svc.acceptInvitation(invB.id, now + 100 * INVITATION_TTL_MS);
  assert.ok(acceptAgain.ok);
  assert.equal(svc.getTask(task.id)!.status, "accepted");
  assert.equal(svc.getTask(task.id)!.acceptedStaffId, "staff-B");
  svc.close();
});

test("候选耗尽任务结束为无人可派，每人最多获邀一次，不再自动重试", () => {
  const svc = makeService();
  const now = BASE;
  const task = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-1"), serviceTime: BASE + DAY, candidates: ["staff-A"] },
    now,
  );
  assert.equal(task.status, "inviting");
  const processed = svc.processExpiredInvitations(now + INVITATION_TTL_MS);
  assert.equal(processed.tasks[0]!.status, "unassignable");
  assert.equal(processed.tasks[0]!.currentInvitation, null);
  // 之后再次处理不会有任何变化
  const again = svc.processExpiredInvitations(now + 2 * INVITATION_TTL_MS);
  assert.equal(again.expiredInvitationIds.length, 0);
  assert.equal(svc.getTask(task.id)!.status, "unassignable");
  svc.close();
});

test("待接受邀请立即预占名额，到期后即使未处理也不再占额", () => {
  const svc = makeService();
  const now = BASE;
  createAccepted(svc, "staff-A", student("s-a"), BASE, now);
  createAccepted(svc, "staff-A", student("s-b"), BASE + 10 * HOUR, now);
  // 待接受邀请在 20h → 立即占第 3 份
  const pending = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-c"), serviceTime: BASE + 20 * HOUR, candidates: ["staff-A"] },
    now,
  );
  assert.equal(pending.status, "inviting");
  // 12h：窗口 [0h,24h) 内 0/10/12/20h 共 4 份 → 拒绝
  const blocked = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-d"), serviceTime: BASE + 12 * HOUR, candidates: ["staff-A"] },
    now,
  );
  assert.equal(blocked.status, "unassignable");
  // 邀请到期（未调用到期处理）→ 20h 占额释放，12h 允许
  const freed = svc.createTask(
    { idempotencyKey: nextKey(), target: student("s-e"), serviceTime: BASE + 12 * HOUR, candidates: ["staff-A"] },
    now + INVITATION_TTL_MS,
  );
  assert.equal(freed.status, "inviting");
  svc.close();
});

test("接受不存在的邀请返回失败", () => {
  const svc = makeService();
  const result = svc.acceptInvitation("no-such-invitation", BASE);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invitation_not_found");
  svc.close();
});
