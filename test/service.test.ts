import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  DispatchService,
  INVITATION_TTL_MS,
  openDatabase,
  type TargetRef,
  type TaskView,
} from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = 1_700_000_000_000;
const NOW = 1_800_000_000_000;

interface Fixture {
  service: DispatchService;
  db: DatabaseSync;
}

function makeFixture(): Fixture {
  const db = openDatabase(":memory:");
  return { service: new DispatchService(db), db };
}

function createTask(
  service: DispatchService,
  key: string,
  target: TargetRef,
  serviceTimeMs: number,
  candidates: string[],
  nowMs: number = NOW,
): TaskView {
  return service.createTask({
    idempotencyKey: key,
    target,
    serviceTimeMs,
    candidates,
    nowMs,
  });
}

function createAccepted(
  service: DispatchService,
  key: string,
  target: TargetRef,
  serviceTimeMs: number,
  worker: string,
): void {
  const view = createTask(service, key, target, serviceTimeMs, [worker]);
  assert.ok(view.currentInvitation, `${key} should have an invitation`);
  const result = service.acceptInvitation(
    view.currentInvitation.invitationId,
    NOW,
  );
  assert.equal(result.ok, true, `${key} should be accepted`);
}

test("发起派单：选择排序最前的合格候选人并预占名额", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "k1",
    { type: "student", id: "s1" },
    BASE,
    ["w1", "w2"],
  );
  assert.equal(view.status, "inviting");
  assert.equal(view.currentInvitation?.workerId, "w1");
  assert.equal(
    view.currentInvitation?.expiresAtMs,
    NOW + INVITATION_TTL_MS,
  );
  db.close();
});

test("同一幂等键重试返回现有任务，不重新派发", () => {
  const { service, db } = makeFixture();
  const first = createTask(
    service,
    "k1",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  const second = createTask(
    service,
    "k1",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  assert.equal(second.taskId, first.taskId);
  assert.equal(
    second.currentInvitation?.invitationId,
    first.currentInvitation?.invitationId,
  );
  db.close();
});

test("乱序补录：服务时刻乱序录入不影响24小时窗口限制", () => {
  const { service, db } = makeFixture();
  const worker = "w1";
  // 乱序录入：23小时、0小时、10小时
  createAccepted(service, "o1", { type: "student", id: "a" }, BASE + 23 * HOUR, worker);
  createAccepted(service, "o2", { type: "student", id: "b" }, BASE, worker);
  createAccepted(service, "o3", { type: "student", id: "c" }, BASE + 10 * HOUR, worker);

  // 新增12小时预约：窗口 [0h, 24h) 内将有 0/10/12/23 共4份，必须拒绝
  const at12 = createTask(
    service,
    "o4",
    { type: "student", id: "d" },
    BASE + 12 * HOUR,
    [worker],
  );
  assert.equal(at12.status, "unassignable");
  assert.equal(at12.currentInvitation, null);

  // 新增24小时预约：允许
  const at24 = createTask(
    service,
    "o5",
    { type: "student", id: "e" },
    BASE + 24 * HOUR,
    [worker],
  );
  assert.equal(at24.status, "inviting");
  assert.equal(at24.currentInvitation?.workerId, worker);

  // 新增24小时减1毫秒预约：必须拒绝
  const at24minus1 = createTask(
    service,
    "o6",
    { type: "student", id: "f" },
    BASE + 24 * HOUR - 1,
    [worker],
  );
  assert.equal(at24minus1.status, "unassignable");
  db.close();
});

test("同一目标相隔14天允许、少1毫秒拒绝", () => {
  const { service, db } = makeFixture();
  const worker = "w1";
  const target: TargetRef = { type: "class", id: "c1" };
  createAccepted(service, "g1", target, BASE, worker);

  const exactly14 = createTask(service, "g2", target, BASE + 14 * DAY, [worker]);
  assert.equal(exactly14.status, "inviting");

  const less1ms = createTask(
    service,
    "g3",
    target,
    BASE + 14 * DAY - 1,
    [worker],
  );
  assert.equal(less1ms.status, "unassignable");
  db.close();
});

test("同号学生和班级不是同一目标", () => {
  const { service, db } = makeFixture();
  const worker = "w1";
  createAccepted(service, "t1", { type: "student", id: "1" }, BASE, worker);
  const view = createTask(
    service,
    "t2",
    { type: "class", id: "1" },
    BASE + HOUR,
    [worker],
  );
  assert.equal(view.status, "inviting");
  db.close();
});

test("待接受邀请立即预占名额", () => {
  const { service, db } = makeFixture();
  const worker = "w1";
  // 三份待接受邀请（未接受也占额）
  createTask(service, "p1", { type: "student", id: "a" }, BASE, [worker]);
  createTask(service, "p2", { type: "student", id: "b" }, BASE + HOUR, [worker]);
  createTask(service, "p3", { type: "student", id: "c" }, BASE + 2 * HOUR, [worker]);
  // 第四份落在同一24小时窗口内，必须跳过该工人
  const view = createTask(
    service,
    "p4",
    { type: "student", id: "d" },
    BASE + 3 * HOUR,
    [worker],
  );
  assert.equal(view.status, "unassignable");
  db.close();
});

test("接受邀请：首次接受成功且重复接受保持成功", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "a1",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  const invitationId = view.currentInvitation!.invitationId;
  const first = service.acceptInvitation(invitationId, NOW + 1000);
  assert.equal(first.ok, true);
  assert.equal(first.task?.status, "accepted");
  assert.equal(first.task?.acceptedWorkerId, "w1");
  const second = service.acceptInvitation(invitationId, NOW + 2000);
  assert.equal(second.ok, true);
  assert.equal(second.task?.status, "accepted");
  db.close();
});

test("邀请到达截止时刻即失效，迟到接受被拒绝", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "e1",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  const invitation = view.currentInvitation!;
  // 截止前1毫秒仍可接受
  const justInTime = service.acceptInvitation(
    invitation.invitationId,
    invitation.expiresAtMs - 1,
  );
  assert.equal(justInTime.ok, true);
  db.close();

  const fixture2 = makeFixture();
  const view2 = createTask(
    fixture2.service,
    "e2",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  const invitation2 = view2.currentInvitation!;
  // 到达截止时刻即失效
  const late = fixture2.service.acceptInvitation(
    invitation2.invitationId,
    invitation2.expiresAtMs,
  );
  assert.equal(late.ok, false);
  assert.equal(late.reason, "invitation_expired");
  fixture2.db.close();
});

test("到期处理：按相同规则改派，新期限从处理时刻起算", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "r1",
    { type: "student", id: "s1" },
    BASE,
    ["w1", "w2"],
  );
  const first = view.currentInvitation!;
  assert.equal(first.workerId, "w1");
  const processAt = first.expiresAtMs + 5000;
  const result = service.processExpiredInvitations(processAt);
  assert.deepEqual(result.expiredInvitationIds, [first.invitationId]);
  const after = service.getTask(view.taskId, processAt)!;
  assert.equal(after.status, "inviting");
  assert.equal(after.currentInvitation?.workerId, "w2");
  assert.equal(after.currentInvitation?.issuedAtMs, processAt);
  assert.equal(after.currentInvitation?.expiresAtMs, processAt + INVITATION_TTL_MS);
  db.close();
});

test("每人对同一任务最多获邀一次，无合格候选时任务结束", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "n1",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  const invitation = view.currentInvitation!;
  const processAt = invitation.expiresAtMs;
  service.processExpiredInvitations(processAt);
  const after = service.getTask(view.taskId, processAt)!;
  assert.equal(after.status, "unassignable");
  assert.equal(after.currentInvitation, null);
  // 再次处理不会复活任务
  const again = service.processExpiredInvitations(processAt + DAY);
  assert.deepEqual(again.expiredInvitationIds, []);
  const final = service.getTask(view.taskId, processAt + DAY)!;
  assert.equal(final.status, "unassignable");
  db.close();
});

test("失效邀请的迟到接受不能覆盖新邀请，也不能恢复占额", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "l1",
    { type: "student", id: "s1" },
    BASE,
    ["w1", "w2"],
  );
  const expired = view.currentInvitation!;
  const processAt = expired.expiresAtMs;
  service.processExpiredInvitations(processAt);
  const late = service.acceptInvitation(expired.invitationId, processAt + 1000);
  assert.equal(late.ok, false);
  assert.equal(late.reason, "invitation_expired");
  const after = service.getTask(view.taskId, processAt + 1000)!;
  assert.equal(after.currentInvitation?.workerId, "w2");
  assert.equal(after.acceptedWorkerId, null);
  db.close();
});

test("过期邀请不再占额，即使尚未调用到期处理", () => {
  const { service, db } = makeFixture();
  const worker = "w1";
  // 三份邀请占满窗口，随后全部过期（未调用到期处理）
  const t1 = createTask(service, "x1", { type: "student", id: "a" }, BASE, [worker]);
  const t2 = createTask(service, "x2", { type: "student", id: "b" }, BASE + HOUR, [worker]);
  const t3 = createTask(service, "x3", { type: "student", id: "c" }, BASE + 2 * HOUR, [worker]);
  const later = t3.currentInvitation!.expiresAtMs;
  assert.ok(t1.currentInvitation!.expiresAtMs <= later);
  assert.ok(t2.currentInvitation!.expiresAtMs <= later);
  // 在 later 时刻，三份邀请均已失效，新任务应能派给同一工人
  const view = createTask(
    service,
    "x4",
    { type: "student", id: "d" },
    BASE + 3 * HOUR,
    [worker],
    later,
  );
  assert.equal(view.status, "inviting");
  assert.equal(view.currentInvitation?.workerId, worker);
  db.close();
});

test("已接受安排不再受邀请期限影响", () => {
  const { service, db } = makeFixture();
  const view = createTask(
    service,
    "ac1",
    { type: "student", id: "s1" },
    BASE,
    ["w1"],
  );
  const invitation = view.currentInvitation!;
  service.acceptInvitation(invitation.invitationId, NOW);
  const result = service.processExpiredInvitations(NOW + DAY);
  assert.deepEqual(result.expiredInvitationIds, []);
  const after = service.getTask(view.taskId, NOW + DAY)!;
  assert.equal(after.status, "accepted");
  assert.equal(after.acceptedWorkerId, "w1");
  db.close();
});

test("改派时跳过当前不合格的候选，且过期邀请释放的名额立即可用", () => {
  const { service, db } = makeFixture();
  // w2 在目标时段附近已有3份占额，不合格；w1 的邀请过期后应改派给 w3
  createAccepted(service, "b1", { type: "student", id: "a" }, BASE, "w2");
  createAccepted(service, "b2", { type: "student", id: "b" }, BASE + HOUR, "w2");
  createAccepted(service, "b3", { type: "student", id: "c" }, BASE + 2 * HOUR, "w2");
  const view = createTask(
    service,
    "b4",
    { type: "student", id: "d" },
    BASE + 3 * HOUR,
    ["w2", "w1", "w3"],
  );
  // w2 不合格，派给 w1
  assert.equal(view.currentInvitation?.workerId, "w1");
  const processAt = view.currentInvitation!.expiresAtMs;
  service.processExpiredInvitations(processAt);
  const after = service.getTask(view.taskId, processAt)!;
  // w1 已获邀过，w2 仍不合格，改派 w3
  assert.equal(after.currentInvitation?.workerId, "w3");
  db.close();
});
