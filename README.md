# novasphere-billing

VPS 月度计费库：上层补录实例生命周期记录（启停 / 套餐变更），查询单实例 UTC 自然月账单。
数据持久化在 SQLite（`node:sqlite`，零原生依赖），本库不负责执行任何 VPS 操作。

## 要求

- Node.js >= 22.13（内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试（编译 + node:test）

## 用法

```ts
import { BillingService } from 'novasphere-billing';

const service = new BillingService('billing.db'); // 或 ':memory:'

// 补录记录：可任意乱序、可补报历史任意位置；相同 eventId 重放无副作用
service.record({
  instanceId: 'vm-1',
  eventId: 'evt-unique-1',
  effectiveAt: Date.UTC(2025, 2, 10, 8, 0, 0), // 毫秒精度 UTC 生效时刻
  kind: 'start',                                // 'start' | 'stop' | 'plan'
});
service.record({
  instanceId: 'vm-1',
  eventId: 'evt-unique-2',
  effectiveAt: Date.UTC(2025, 2, 12, 9, 0, 0),
  kind: 'plan',
  plan: 'Medium',                               // 'Small' | 'Medium' | 'Large'
});

// 查看月账单：month 为该 UTC 自然月内任意时刻（ms）
const bill = service.getMonthlyBill('vm-1', Date.UTC(2025, 2, 1));
// bill.lines: 按套餐列项 { plan, runningMs, amountCents }
// bill.totalCents: 各项已舍入费用之和（BigInt，美分）

service.close(); // 正常关闭；重启后打开同一路径，记录与账单结果不变
```

批量装载用 `service.recordAll(events)`（单事务写入）。

## 计费规则

- 实例默认停止、默认 Small 套餐；启停与套餐变更互不影响，各自持续有效直到被同类记录覆盖。
- 仅运行期间计费：Small $0.015/h、Medium $0.045/h、Large $0.12/h。
- 账期为 UTC 自然月 `[月初, 下月月初)`，左含右不含；月初状态由此前记录决定。
- 各套餐分别累计全月运行毫秒数，再按小时价格以整数精确计算，四舍五入到美分（恰好半分向上）；
  账单总额 = 各项已舍入费用之和。启停碎片不影响相同用量的费用。

## 设计

- `src/store.ts`：SQLite 持久化，`event_id` 主键保证重放幂等（`INSERT OR IGNORE`）。
- `src/billing.ts`：纯函数计费核心，BigInt 精确舍入；列式扫描版本用于热点路径。
- `src/service.ts`：门面。账单按 (实例, 月) 缓存在内存（列式事件存储，支持任意位置高效插入），
  补录仅失效受影响月份；重启后从 SQLite 记录惰性重建，结果不变。
