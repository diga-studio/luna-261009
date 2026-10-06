# task26100922

设施区域可预约时隙计算库（TypeScript）。单区域内存状态，调用顺序执行。

## 使用

```ts
import { FacilityZone } from "./src/index";

const zone = new FacilityZone({
  capacity: 3,                          // 固定容量 C
  closedDates: ["2026-03-11"],          // 关闭日期（UTC，YYYY-MM-DD）
  closures: [{ start: 1773300600000, end: 1773303000000 }], // 临时闭区，UTC 毫秒，左闭右开
});

zone.upsertBooking("a", startMs, endMs, 2); // 新增或完整替换同 id 占用
zone.deleteBooking("a");                     // 移除；不存在的 id 无效果
const slots = zone.listSlots(fromMs, toMs, 30 * 60 * 1000);
// => [{ start, end, remaining }]，仅含 remaining > 0 的时隙
```

规则：营业时间每天 05:00–21:00（UTC），时隙起点按每天 05:00 起的 30 分钟网格排列；
所有区间左闭右开；`remaining = max(0, C - 时隙内最大同时占用)`；时间轴限定 2025–2034 年。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 devDependencies 中的 `typescript`；测试使用 Node 内置 `node:test`，编译后运行。
