# novasphere-billing

VPS 月度计费库（TypeScript + SQLite）。上层补录实例生命周期记录，
并可随时查看单实例的 UTC 自然月账单。本库不执行任何 VPS 操作。

## 特性

- 记录任意乱序到达、可在历史任意位置补报；相同 `eventId` 的重放自动忽略。
- 只按运行时长收费，费率按记录生效时刻的套餐确定（不用当前套餐倒算）。
- 账单按套餐列项，精确计算后四舍五入到美分（恰好半分向上），
  总额为各列项舍入后之和；启停碎片不影响费用。
- SQLite 持久化，正常重启后记录与账单结果不丢失。
- 内存时间线索引 + 账单缓存：百万级记录下热点月高频查询保持毫秒级。

## 使用

```ts
import { BillingService } from "novasphere-billing";

const service = new BillingService("billing.sqlite"); // 或 ":memory:"

service.ingest({
  eventId: "evt-1",            // 全局唯一
  instanceId: "vm-42",
  effectiveAt: Date.parse("2026-03-10T08:00:00.000Z"), // UTC 毫秒
  kind: "start",               // "start" | "stop" | "plan"
});
service.ingest({
  eventId: "evt-2",
  instanceId: "vm-42",
  effectiveAt: Date.parse("2026-03-10T08:00:00.000Z"),
  kind: "plan",
  plan: "medium",              // "small" | "medium" | "large"
});

const bill = service.getMonthlyBill("vm-42", 2026, 3);
// bill.lineItems: [{ plan, runningMs, costCents }, ...]
// bill.totalCents = 各列项 costCents 之和

service.close();
```

## 规则摘要

- 实例默认停止、默认 Small 套餐；启停记录不改套餐，套餐记录不改启停。
- 各类状态持续有效，直到被后续同类记录覆盖；同刻的启停与套餐变更同时生效。
- 账单覆盖 `[月初, 下月月初)` UTC 区间，月初状态由此前记录决定。
- 费率（美元/小时）：Small 0.015、Medium 0.045、Large 0.12。

## 开发

```sh
npm install   # 仅需 Node.js >= 22.5（使用内置 node:sqlite）
npm test      # 编译并运行全部测试（含性能验收）
```
