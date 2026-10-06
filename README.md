# task26100922

单设施区域的可预约时隙计算库（TypeScript，纯内存，无外部服务）。

- 营业时间固定每天 05:00–21:00（UTC），时隙起点锚定每日 05:00 的 30 分钟网格
- 所有时间为 UTC 整数毫秒，区间左闭右开，时间轴限定 2025–2034 年
- `remaining = capacity - 时隙内最大同时占用`，仅返回 `remaining > 0` 的时隙
- 关闭日期 / 临时闭区在创建时固定；任何局部闭区使相交的整个候选时隙不可用

## API

```ts
import { FacilityZone } from "./src";

const zone = new FacilityZone({
  capacity: 3,
  closedDates: [/* 任意落在关闭日内的 UTC 毫秒时间戳 */],
  closures: [{ start, end }], // 临时闭区，左闭右开
});

zone.upsertBooking("id", start, end, units); // 新增或完整替换同一 id
zone.deleteBooking("id");                    // 不存在则无操作
zone.listSlots(from, to, duration);          // duration 为 30 分钟正整数倍
// => [{ start, end, remaining }]
```

## 构建与测试

只需 Node.js：`npm install && npm test`（`npm test` 会先 `tsc` 构建再运行 node:test）。
