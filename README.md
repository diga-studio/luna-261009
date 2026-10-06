# permission-drift-analyzer

权限漂移分析库：基于本地 JSON 快照，计算审计时刻起 8 小时内的过度授权时段。由上层审计程序直接调用，快照在分析期间视为不可变，结果由调用方自行保存。

## 使用

```bash
npm install
npm test        # 构建并运行全部测试（含规模性能测试）
npm run build   # 仅构建到 dist/
```

```ts
import { analyzeDrift, type Snapshot, type DriftInterval } from 'permission-drift-analyzer';

const snapshot: Snapshot = JSON.parse(fs.readFileSync('snapshot.json', 'utf8'));
const intervals: DriftInterval[] = analyzeDrift(snapshot);
// 调用方负责持久化 intervals
```

## 规则摘要

- 分析范围为 `[auditMs, auditMs + 8h)`，所有区间左闭右开、整数毫秒。
- 每日窗口按 UTC 的 `"hh:mm AM/PM"` 解释：起点含、终点不含；结束早于开始为跨午夜；起终相同为全天。
- 某时刻存在匹配且生效的 deny 即禁止（与优先级无关）；否则取生效 allow 的最小优先级，同级取最短会话时长，审批要求为同级逻辑或；无 allow 即禁止。
- 授权仅在自身起止区间内提供访问；合规还要求审批条件满足，且时刻早于 `授权开始 + 选定会话时长`，不回退到次优策略。
- 同一 (用户, 环境, 资源类型) 上只要有一份合规授权覆盖即不漂移；仅当实际访问存在且无合规覆盖时报告，区间合并重叠及首尾相接部分。

## 结构

- `src/types.ts` — 快照与结果类型
- `src/timeWindow.ts` — 每日窗口解析与包含判断
- `src/policy.ts` — 单时刻策略判定（含预编译热路径）
- `src/intervals.ts` — 区间合并与差集
- `src/analyzer.ts` — 分组扫描线全量分析
- `test/` — 单元测试、验收测试、独立参考实现对比、规模性能测试

## 性能

在 5000 身份 / 50 环境 / 20000 策略 / 100000 授权的规模下，本机实测全量分析约 0.5 秒、新增堆内存约 65 MiB（限制：10 秒 / 256 MiB），见 `test/perf.test.ts`。
