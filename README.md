# 校园预约派单库

TypeScript 实现的单校区预约派单库，数据保存在 SQLite（使用 Node.js 内置
`node:sqlite`，无原生依赖）。所有时间均为毫秒时间戳，业务时钟由上层传入。

## 构建与测试

```sh
npm install
npm test
```

要求 Node.js >= 22.5（`node:sqlite`）。

## API

```ts
import { openDatabase, DispatchService } from "campus-dispatch";

const db = openDatabase("dispatch.db"); // 或 ":memory:"
const service = new DispatchService(db);

// 1. 发起派单（幂等：同一 idempotencyKey 重试返回现有任务）
const task = service.createTask({
  idempotencyKey: "req-001",
  target: { type: "student", id: "S1001" }, // 或 { type: "class", id: "C01" }
  serviceTimeMs: 1_700_000_000_000,
  candidates: ["worker-a", "worker-b"],     // 按优先级排列
  nowMs: Date.now(),
});

// 2. 接受邀请（重复接受已成功的邀请保持成功）
const result = service.acceptInvitation(
  task.currentInvitation!.invitationId,
  Date.now(),
);

// 3. 处理到期邀请（失效、释放占额并按相同规则改派）
service.processExpiredInvitations(Date.now());

// 4. 查看任务
const view = service.getTask(task.taskId, Date.now());
```

## 规则摘要

- 每个任务最多一个有效邀请或一份已接受安排；每人对同一任务最多获邀一次。
- 待接受邀请立即预占名额；接受只改变状态，不再扣额。
- 占额按服务时刻计数：同一工作人员任意连续 24 小时（含起点、不含终点）
  最多 3 份占额安排。
- 同一工作人员对同一目标（类型 + 标识）的两份占额安排至少相隔 14 天，
  恰好 14 天允许。
- 邀请自发出起 10 分钟有效，到达截止时刻即失效且不再占额；
  已接受安排不受邀请期限影响。
- 无合格候选时任务结束为 `unassignable`，不再自动重试。
