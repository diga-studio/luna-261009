# pump-rul-twin

泵类数字孪生的剩余寿命计算库（TypeScript）。每个 `PumpTwin` 实例对应一台泵，
参数与遥测保存在进程内存中，由上层直接调用；本次实现线性退化预测。

## 使用

```ts
import { PumpTwin } from 'pump-rul-twin';

const twin = new PumpTwin(3000, 100); // 额定转速、额定扬程

// 批量写入遥测（可乱序；同一时间戳重复写入视为整条更正，以最后写入为准）
twin.writeTelemetry([
  { timestampMs: 1_700_000_000_000, speed: 2950, head: 98.5 },
  { timestampMs: 1_700_000_100_000, speed: 0, head: 0 }, // 停机
]);

// 按指定时刻查询寿命：只使用 [T-30天, T] 窗口内的遥测（两端包含）
const r = twin.assessRemainingLife(1_700_000_200_000);
switch (r.status) {
  case 'insufficient-data':   // 窗口内有效运行点少于 2 个
    break;
  case 'depleted':            // 拟合值 <= 0.8，余寿命为 0
    break;
  case 'no-finite-estimate':  // 每运行小时下降不超过 1e-6，无有限估计
    break;
  case 'finite':              // r.remainingOperatingHours 为剩余运行小时
    break;
}
```

## 语义要点

- 任一转速下的预期扬程 = 额定扬程 × (转速/额定转速)²；归一化扬程 = 实际扬程 / 预期扬程（不截断）。
- 一条遥测的转速从其时间戳生效至下一条时间戳（不含）；最早记录之前视为停机，
  最后记录之后保持最后转速。转速为 0 的区间不累计运行小时。
- 拟合点横坐标为窗口左端至该点累计的运行小时，纵坐标为归一化扬程；
  等权最小二乘拟合直线。历史更正会按更正后的完整时间线重新理解工时。
- 余寿命是运行小时（不是自然小时），表示拟合直线下降到 0.8 还需经历的运行小时。

## 开发

```sh
npm install
npm test   # 编译并运行全部测试（含 100 万条记录的性能用例）
```
