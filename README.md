# pump-rul-twin

泵类数字孪生的剩余寿命（RUL）计算库。进程内存实现，每个 `PumpTwin` 实例对应一台泵，当前仅做线性退化预测。

## 使用

```ts
import { PumpTwin } from 'pump-rul-twin';

const twin = new PumpTwin(3000, 100); // 额定转速、额定扬程

twin.writeBatch([
  { timestampMs: 1_700_000_000_000, rpm: 3000, head: 99.5 },
  { timestampMs: 1_700_003_600_000, rpm: 0, head: 0 }, // 停机
]);

const result = twin.predict(1_700_007_200_000);
```

`predict` 返回判别联合：

- `{ status: 'insufficient-data' }` — 窗口内有效点少于两个；
- `{ status: 'no-finite-estimate', slope, fittedValue }` — 拟合值高于 0.8 且每运行小时下降不超过 1e-6；
- `{ status: 'exhausted', slope, fittedValue, remainingLifeHours: 0 }` — 拟合值不高于 0.8；
- `{ status: 'ok', slope, fittedValue, remainingLifeHours }` — 直线下降到 0.8 还需的运行小时数（非自然小时）。

## 语义要点

- 预期扬程 = 额定扬程 × (转速/额定转速)²；归一化扬程 = 实际扬程 / 预期扬程，不截断。
- 一条遥测的转速从其时间戳生效到下一条时间戳（不含）；最早记录之前视为停机，最后记录之后保持最后转速。转速 > 0 的区间累计运行小时。
- 同一时间戳重复写入视为整条更正，以最后写入为准；不同时间戳可乱序到达。
- 查询时刻 T 只使用时间戳落在 [T−30天, T]（两端包含，一天固定 24 小时）内的遥测；横坐标为窗口左端起算的累计运行小时，等权最小二乘拟合。

## 性能设计

遥测保存在带父指针的随机 treap 中（`src/timeline.ts`）。每个节点保存到后继节点的运行小时增量，以及以“进入子树时的累计工时”为未知量的子树聚合（点数、Σy、Σx、Σxy、Σx²、区间工时），合并只需 O(1) 平移。因此：

- 单点写入/更正：O(log n)，历史更正自动重算后续工时；
- 窗口聚合查询：O(log n)；
- 100 万条记录下，2000 次历史更正 + 2000 次查询实测约 32 ms（限制 10 s）。

## 开发

```sh
npm install
npm test        # tsc 编译 + node --test
```

测试包含一个独立的逐点重算参考实现（`test/reference.ts`），所有随机/更正场景均与其对照，有限余寿命相对误差 ≤ 1e-6。
