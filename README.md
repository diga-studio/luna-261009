# campaign-notification-lib

定时通知活动投递库（TypeScript + SQLite），由上层零售应用直接以库的形式调用，无接口层。
客户分群事实、活动进度与个人通知全部持久化到 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（内置 `node:sqlite`；建议 Node 24）
- `npm install` 后 `npm test` 即可运行全部测试（仅需 devDependencies 中的 TypeScript 工具链）

## 命令

- `npm run build`：编译 `src/` 到 `dist/`
- `npm test`：编译并运行 `test/` 中的全部测试

## API 概览

```ts
import { openDatabase, NotificationService } from 'campaign-notification-lib';

const svc = new NotificationService(openDatabase('data.sqlite'));
```

- `upsertCustomer(state, now)`：录入/更新客户当前状态（客户ID、最近成交时间、购物车是否非空、购物车最后更新时间）。
- `createCampaign({ id, title, body, segment, scheduledAt }, now)`：安排活动；创建后内容不可修改，初始状态 `scheduled`。
- `advance(campaignId, now, batchSize)`：分轮推进。到达计划时刻后以该轮逻辑时间 `t` 与当时已持久化的客户状态快照固定收件名单，之后每轮最多投递 `batchSize` 条，并清理已过期通知。
- `getCampaign(campaignId)`：查看活动状态（`scheduled` / `sending` / `sent`）。
- `getNotifications(customerId, now)`：读取某人当前可见通知（到期时刻本身不可读）。

## 语义要点

- 分群：`all`（全部客户）、`recent_buyers`（最近成交 ∈ [t-30天, t] 闭区间）、`stale_cart`（购物车非空且最后更新距 t 严格超过 48 小时）。一天按 24 小时计。
- 名单与 `t` 在进入 `sending` 时固定；之后新增客户或修改事实不影响该活动名单。
- 每个活动对每个收件人最多一条通知；通知统一在 `t + 30天` 到期，投递时间不影响到期时刻。
- 活动到期后未处理的收件人按“无需投递”完成；全部收件人投递或到期跳过之后活动进入 `sent`，且不可回退。
- 所有操作使用上层传入的单调不减逻辑时间（库会校验），无需真实等待或定时线程。
