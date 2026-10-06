# campaign-notification-lib

定时通知活动投递库（TypeScript + SQLite），由上层零售应用直接以库的形式调用，无接口层。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部服务依赖）
- `npm install && npm test` 即可构建并运行全部测试

## 用法

```ts
import { openDatabase } from "./src/db.js";
import { NotificationLibrary } from "./src/library.js";

const lib = new NotificationLibrary(openDatabase("data.sqlite"));

// 录入客户事实（上层提供，单调不减的逻辑时间）
lib.upsertCustomer({ customerId: "c1", lastPurchaseAt: t, cartNonempty: true, cartUpdatedAt: t }, t);

// 安排活动（创建后内容不可修改）
lib.createCampaign({ id: "camp1", title: "标题", body: "正文", segment: "recent_purchase", scheduledAt });

// 分轮推进投递：到达计划时刻后进入 sending，按 batchSize 逐轮投递
lib.advanceCampaign("camp1", now, 100);

// 查询
lib.getCampaign("camp1");
lib.listNotifications("c1", now);
```

## 语义要点

- 分群：`all` / `recent_purchase`（t 前 30 天至 t 闭区间）/ `stale_cart`（购物车非空且更新距 t 严格超过 48 小时）。
- 活动进入 `sending` 时以该轮逻辑时间 t 快照收件名单，之后客户事实变化不影响名单。
- 通知统一在 t+30 天到期，到期时刻本身不可读；推进时分轮清除过期通知，未投递收件人按无需投递完成。
- 名单全部投递或到期完成后活动变为 `sent`，不可逆，重复推进不再产生通知。
- 所有操作使用上层传入的单调不减逻辑时间，无定时线程。
