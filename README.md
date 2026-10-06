# permission-drift-analyzer

权限漂移分析库：对本地 JSON 快照（身份、环境、策略、已发放授权、审计时刻）做全量分析，
找出 **[审计时刻, 审计时刻+8h) 内"实际访问存在、但没有任何合规授权覆盖"的时段**。
快照在分析期间不可变，结果由调用方自行保存。

## 使用

```ts
import { analyzeDrift, type Snapshot, type DriftInterval } from 'permission-drift-analyzer';

const drifts: DriftInterval[] = analyzeDrift(snapshot);
// => [{ userId, environmentId, resourceType, startMs, endMs }, ...]
//    区间左闭右开，精确到毫秒；同一 (用户, 环境, 资源类型) 上的重叠/首尾相接区间已合并。
```

## 规则要点

- 每日窗口按 UTC 解释，格式 `hh:mm AM/PM`；起点含、终点不含；结束早于开始为跨午夜；相等为全天。
- 某时刻存在生效的拒绝策略即禁止访问（无视优先级）；否则取生效允许策略的最小优先级，
  同级取最短会话时长；同级同长的策略中任意一条要求审批则必须审批。
  会话时长耗尽或审批未完成时**不退回**次优策略。
- 授权仅在自身 `[startMs, endMs)` 内提供访问；合规还要求审批条件满足且
  时刻早于 `startMs + 选定最长会话时长`。
- 同一 (用户, 环境, 资源类型) 上的多份授权共同提供权限：至少一份合规即不算漂移。
- 只报告过度授权时段，不报告缺少应有权限的情况。

## 构建与测试

```sh
npm install
npm test   # 编译 + 单元测试 + 验收场景 + 1000 例随机交叉验证 + 规模/性能测试
```

性能：5000 身份 / 50 环境 / 20000 策略 / 100000 授权的规模下，
全量分析远低于 10 秒、新增堆内存远低于 256 MiB（实测见 `test/perf.test.ts` 输出）。
