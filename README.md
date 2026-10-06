# 校园预约派单库

TypeScript 实现的单校区预约派单库，数据保存在 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 环境要求

- Node.js >= 22.5（`node:sqlite` 内置模块）
- 仅开发依赖 TypeScript，`npm install` 后即可构建与测试

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## 使用方式

```ts
import { DispatchService, openDatabase } from "campus-dispatch";

const svc = new DispatchService(openDatabase("dispatch.db")); // 或 ":memory:"

// 1. 发起派单（now 为上层提供的业务时钟，毫秒，单调不倒退）
const task = svc.createTask(
  {
    idempotencyKey: "req-123",                 // 同一键只产生一个任务，重试返回现有任务
    target: { type: "student", id: "20240101" }, // 或 { type: "class", id: "..." }
    serviceTime: 1_700_000_000_000,            // 服务时刻，毫秒
    candidates: ["staff-1", "staff-2"],        // 按优先级排列
  },
  Date.now(),
);

// 2. 接受邀请（仅当前且未到期的邀请可首次接受；重复接受已成功邀请保持成功）
const result = svc.acceptInvitation(task.currentInvitation!.id, Date.now());

// 3. 处理到期邀请（按相同资格规则改派，新邀请期限从处理时刻起算）
svc.processExpiredInvitations(Date.now());

// 4. 查看任务
const view = svc.getTask(task.id);
```

## 业务规则

- 每个任务最多一个有效邀请或一份已接受安排；每次派发按原排序选择尚未获邀且当前合格的第一名，每人对同一任务最多获邀一次；无合格候选时任务结束为 `unassignable`，不再自动重试。
- 待接受邀请立即预占名额，接受只改变状态；有效邀请与已接受安排均按服务时刻计数。
- 同一工作人员任意连续 24 小时（含起点、不含终点）最多 3 份占额安排。
- 同一工作人员对同一目标（类型 + 标识）的两份占额安排，服务时刻至少相隔 14 天（恰好 14 天允许）。
- 邀请自发出起 10 分钟有效，到达截止时刻即失效并释放占额（无需等待到期处理）；已接受安排不受邀请期限影响。
