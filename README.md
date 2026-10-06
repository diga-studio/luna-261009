# weekly-settlement

跨地点周工时结算库（TypeScript，纯内存，无接口层）。按真实 UTC 工作时间为每个工作时刻确定支付倍率，输出可追溯的分段结算明细。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试（含性能测试）
npm run build   # 仅编译到 dist/
```

```ts
import { settle } from "weekly-settlement";

const result = settle({
  weekStartLocalDate: "2025-03-03",   // 结算周当地周一（员工会计时区）
  employeeTimeZone: "America/New_York",
  initialContinuousSeconds: 0,        // 周起点前已连续工作秒数
  locationTimeZones: { L1: "Asia/Shanghai" },
  holidayRates: { L1: { "2025-03-04": 2 } },  // 仅 1.5 或 2，未标记为 1
  intervals: [
    { employeeId: "E1", sourceId: "S1", locationId: "L1",
      startUtc: 1741035600, endUtc: 1741042800 },  // [起, 止)，epoch 秒
  ],
});
// result.employees[*].segments          —— 分段明细（来源 ID + 最终倍率）
// result.employees[*].totalSecondsByRate —— 1 / 1.5 / 2 倍实际秒数总量
```

## 规则要点

- 日累计按员工会计时区当地日期（超 8h 部分 1.5 倍）；周累计按当地周一至下周一（超 40h 部分 1.5 倍）；连续工作超 12h 部分 2 倍。
- 节日倍率按工作地点时区的当地日期确定；最终倍率取各命中倍率的最大值，不相乘。
- 日期边界取该日期首个真实时刻：夏令时拨快不补工时，拨回不合并重复钟点（全部按 UTC 秒差累计）。
- 任何正长度空档重置连续工时；首尾相接、换地点、跨午夜/跨周均不重置。
- 期初连续工时仅衔接从周起点立即开始的第一段工作，否则失效。
- 高倍率（节日/加班）时间仍参与日、周、连续累计。

## 说明

- 时区计算基于 Node 内置 `Intl`（IANA 时区库），无外部运行时依赖。
- 输入假设已配对审批、同员工无重叠、不越出周边界；库不处理打卡、审批、宽限与取整。
- 单次结算 5000 员工 / 50 地点 / 20 万区间约 1 秒（性能测试见 `test/performance.test.ts`）。
