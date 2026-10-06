# ab-experiment-judge

TypeScript + SQLite 的 A/B 实验判胜库，由上层调用，数据保存在本地 SQLite 文件中。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无需任何原生依赖或外部服务）
- `npm install && npm test` 即可构建并运行全部测试

## 能力

- `createExperiment(id, variantIds)`：建立实验，固定 2 至 5 个变体
- `ingestBatch(id, events)`：接收事件批次，按输入次序逐条生效
- `getResult(id)`：读取实时统计与锁定结果

## 规则摘要

- 事件按 `eventId` 去重；同一访客在同一实验中最多贡献一次曝光、一次转化
- 只有已曝光访客的转化才计入 `c`；转化先到暂存，曝光到达后同时补入 `n` 和 `c`
- 所有变体 `n >= 200` 才允许判胜；某变体对每个其他变体的双比例 Z 检验
  均 `>= 1.959963984540054` 时确认赢家（不取绝对值）
- 锁定点为批内第一个完整生效后满足条件的事件；锁定不可更改，
  锁定证据（触发事件标识、锁定时各变体 n/c 快照）与实时统计分别返回

## 使用示例

```ts
import { ExperimentStore } from "ab-experiment-judge";

const store = new ExperimentStore("./data.sqlite");
store.createExperiment("exp-1", ["A", "B"]);
store.ingestBatch("exp-1", [
  { eventId: "e1", visitorId: "u1", variantId: "A", type: "exposure" },
  { eventId: "e2", visitorId: "u1", variantId: "A", type: "conversion" },
]);
const result = store.getResult("exp-1");
// result.stats: 实时统计；result.lock: 锁定证据（未锁定为 null）
store.close();
```
