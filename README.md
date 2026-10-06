# task26100928
# ab-experiment-judge

TypeScript + SQLite 的 A/B 实验判胜库，数据保存在本地 SQLite 文件中。

## 使用

```bash
npm install
npm test
```

```ts
import { ExperimentStore } from 'ab-experiment-judge';

const store = new ExperimentStore('./ab.sqlite');
store.createExperiment('exp-1', ['A', 'B']); // 2 至 5 个固定变体

store.ingestBatch('exp-1', [
  { eventId: 'e1', visitorId: 'v1', variant: 'A', type: 'exposure' },
  { eventId: 'e2', visitorId: 'v1', variant: 'A', type: 'conversion' },
]);

const result = store.getResult('exp-1');
// result.variants: 实时统计 [{ variant, n, c }]
// result.lock: 首次判胜锁定 { winner, triggerEventId, stats }，未锁定为 null
```

## 规则

- 同一访客最多贡献一次曝光和一次转化；重复事件（同事件标识或换标识重复上报同类行为）不增计。
- 转化先于曝光到达时暂挂，曝光到达后同时补入 n 和 c；无曝光的转化不参与判胜。
- 所有变体 n 均达到 200 才允许判胜；变体对每个其他变体的 Z（不取绝对值）都达到
  1.959963984540054 才确认为赢家。
- 批内事件按输入次序逐个生效，锁定点为第一个完整生效后满足条件的事件；
  锁定后不可更改，锁定证据（触发事件标识与锁定时各变体 n/c）永久保留。
