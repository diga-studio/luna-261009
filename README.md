# journey-funnel

离线旅程漏斗分析库（TypeScript）。由上层分析工具直接调用：原始事件与准备结果
都保存在本地文件，支持数据准备、重新打开和任意毫秒边界的左闭右开时间窗查询。

固定 4 阶段漏斗：`impression → click → click → conversion`。

## 快速开始

```bash
npm install
npm test        # 构建 + 正确性测试 + 全规模基准（1000 万事件）
npm run bench   # 只跑全规模基准
BENCH_SCALE=smoke npm run bench   # 小规模冒烟基准
```

只依赖 Node.js（>=18）与 devDependencies 中的 `typescript` / `@types/node`，
不需要 Docker、数据库或任何监听端口的服务；持久化只用本地文件。

## API

```ts
import { prepareFunnel, openFunnel } from "journey-funnel";

// 1) 数据准备（不计入查询耗时；结果不可变，不支持增量更新）
prepareFunnel(events, "./prepared-dir");

// 2) 打开（另一个新进程打开同一目录，查询结果完全一致）
const db = openFunnel("./prepared-dir");

// 3) 查询：左闭右开窗口 [startMs, endMs)，返回 4 个阶段各自的客户数
const [s1, s2, s3, s4] = db.query(1_700_000_000_000, 1_700_086_400_000);
```

### 输入事件

每个事件包含：客户标识、可信的旅程标识、动作、UTC 毫秒时间（非负有限数）、
同毫秒排序序号 `seq`。输入可以乱序；旅程内按 `(time, seq)` 确定先后。
身份归并、旅程划分、事件去重不在本模块范围内。

支持两种输入形式：

- `Iterable<FunnelEvent>`：`{ customer, journey, action, time, seq }`，
  标识可为字符串或数值，动作名为 `"impression" | "click" | "conversion"`，
  其他动作名一律视为可夹杂的无关动作。
- 列式 `ColumnarEvents`（大规模场景，基准使用）：`customer/journey/action/
  time/seq` 五个等长数组，动作 id 为 `ACTION_IMPRESSION=0`、`ACTION_CLICK=1`、
  `ACTION_CONVERSION=2`、`ACTION_OTHER=3`。

`src/rawfile.ts` 还提供了一种紧凑的原始事件二进制文件格式
（`writeRawEventsFile` / `readRawEventsFile`），基准用它保存 1000 万原始事件。

### 完成语义

- 完成第 k 阶段：同一旅程内存在依次匹配前 k 个动作的**不同**事件，且全部
  位于查询窗口内；允许夹杂其他动作；两个 `click` 阶段不能使用同一事件；
  同毫秒但 `seq` 不同的事件可以依次完成阶段。
- 每个阶段按客户去重：同一客户重复完成或在多个旅程完成只计 1 人；
  不同旅程中的动作不能拼接成一条完成链；各阶段分别判断，不要求同一条
  完整转化链。
- 窗口端点是任意毫秒，左闭右开，不要求落在事件时间上。

## 设计

1. **准备阶段**（`src/prepare.ts`）：稳定计数排序 + LSD 基数排序把事件按
   `(journey, time, seq)` 排好；对每个旅程做一次反向扫描得到每个事件之后
   的下一个 `click` / `conversion`，于是每个 `impression` 事件可以在 O(1)
   内贪心地求出各阶段的最早完成时间，形成"链点" `(chainStart, stageEnd,
   customer)`。窗口 `[S, E)` 内客户完成某阶段，当且仅当该客户存在一个链点
   满足 `chainStart >= S && stageEnd < E`（贪心给出最早完成，存在性等价）。
   同一客户的链点再做 Pareto 前沿压缩（被更晚开始、更早完成的点支配的点
   丢弃）。结果按 `chainStart` 与 `stageEnd` 各存一份有序数组
   （`src/store.ts` 持久化为二进制文件 + `manifest.json`）。

2. **查询阶段**（`src/engine.ts`）：引擎为每个阶段维护"每个客户当前落在
   象限 `chainStart >= S && stageEnd < E` 内的链点引用计数"，计数从 0 变
   非 0（或相反）时更新该阶段客户数。窗口移动时，只需处理 `chainStart`
   落在两端点之间、`stageEnd` 落在两端点之间的链点——相邻查询窗口高度
   重叠、端点只移动几毫秒时，每次查询的开销正比于端点移动量而非窗口
   宽度。当端点跳变过大（估计变动链点数超过阈值）时退化为一次全量重算，
   保证最坏情况有界。首次查询为全量初始化。

3. **重开一致性**：准备结果完全落盘，查询所需的全部状态都由文件重建，
   新进程打开同一目录得到逐位一致的结果（基准中由独立子进程验证）。

## 测试

- `test/correctness.test.ts`：定向用例（同毫秒 `seq` 排序、窗口截掉前置
  动作、左闭右开边界、两个 click 必须用不同事件、同一客户多个交叠旅程
  不能拼接、多旅程完成只计 1 人、夹杂无关动作、各阶段可用不同链）；
  随机小数据与独立的逐旅程完整计算（`src/reference.ts`）做差分对照；
  持久化后进程内重开与**新进程**重开结果一致。
- `test/benchmark.test.ts`：下述全规模基准，作为自动化测试运行。

## 基准

规模：1000 万事件、50 万客户、200 万旅程、365 天跨度，含重复动作、交叠
旅程与每毫秒多事件的密集片段（300 个突发中心）。工作负载：100 次预热 +
10000 次串行查询，模拟拖动时间轴——相邻窗口高度重叠、端点通常只移动
几毫秒、约 1% 跳变；80% 的窗口包含总事件数的 50%–90%；窗口互不相同且
所含首尾事件组合不重复；端点为任意毫秒。计时在**重开准备结果的新进程**
中进行；抽样 25 个窗口与独立的逐旅程完整计算一致；父进程重开执行相同
查询，所有阶段计数与子进程一致。

本机实测（报告见 `npm run bench` 输出）：

| 指标 | 实测 | 目标 |
| --- | --- | --- |
| 10000 次查询总耗时 | ~2.4 s | <= 8 s |
| 单次 p50 / p95 | ~0.003 / ~0.011 ms | p95 <= 2 ms |
| 查询进程峰值 RSS | ~302 MiB | <= 768 MiB |
| 重开一致性 / 抽样校验 | PASS | PASS |

基准数据与查询由固定种子确定性生成（`bench/gen.ts`），可重复复现。
