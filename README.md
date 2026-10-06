# weekly-timesheet-settlement

跨地点周工时结算库（纯内存、无接口层）。按真实 UTC 工作时长确定每段支付倍率，明细可追溯到原始工作区间。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 到 dist/ 并运行 node:test 测试
```

要求 Node.js >= 22.18（测试使用内置 test runner 与 TypeScript 类型剥离）。运行时零依赖，时区数据来自 `Intl`。

## 使用

```ts
import { settleWeek } from "weekly-timesheet-settlement";

const result = settleWeek({
  employees: [
    {
      employeeId: "E1",
      accountingTimeZone: "America/New_York", // 员工会计 IANA 时区
      weekStartLocalDate: "2025-03-03",       // 结算周当地周一日期
      initialContinuousSeconds: 0,            // 周起点前已连续工作秒数
    },
  ],
  locationTimeZones: { L1: "Asia/Shanghai" }, // 地点 -> IANA 时区
  holidayRates: { L1: { "2025-03-05": 1.5 } },// 地点当地日期 -> 1.5 | 2，未标记为 1
  intervals: [
    {
      employeeId: "E1",
      sourceId: "shift-42",
      locationId: "L1",
      startUtc: "2025-03-04T01:00:00Z",       // 起点包含
      endUtc: "2025-03-04T09:00:00Z",         // 终点不包含
    },
  ],
});

// result.employees[i].segments: { sourceId, startUtc, endUtc, rate }[]
// result.employees[i].totals:   { regular, timeAndHalf, double }（实际秒数）
```

## 规则摘要

- 日累计（员工会计时区当地日期）超过 8 小时的部分 1.5 倍；周累计（当地周一起算）超过 40 小时的部分 1.5 倍；一次连续工作超过 12 小时的部分 2 倍。
- 节日倍率按工作地点时区的当地日期确定；每个工作时刻的最终倍率取基础、节日与已命中加班倍率中的最大值，不相乘。
- 任何正长度休息空档重置连续工时；相邻相接、换地点、跨午夜/跨周均不重置。期初连续工时只衔接从周起点立即开始的工作。
- 日界/周界取当地日期的首个真实时刻；工时一律按 UTC 时刻差计算，夏令时切换不多计也不少计。
