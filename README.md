# task26100905

企业词汇测验组卷库（TypeScript，纯内存，无外部服务依赖）。

## 使用

```ts
import { ExamBuilder } from './src/index';

const builder = new ExamBuilder();
builder.loadEntries([
  { id: 'e1', word: 'apple', translation: '苹果', industry: '食品', difficulty: 1 },
  // ... 一个语种的完整词库
]);

const result = builder.generateExam([/* 20 个题干词条的 id */]);
if (result.ok) {
  // result.questions: 恰好 20 题，每题 4 个译文选项（含 1 个正确译文）
  // result.totalDifficultyGap: 整卷总难度差（已最小化）
} else {
  // 整张试卷不存在合法分配
}
```

## 组卷规则

- 每场考试 20 题四选一：展示原词，4 个译文选项中 1 个正确、3 个为干扰项。
- 干扰词条须与题干行业标签相同、难度差绝对值不超过 1，且译文不等于正确译文。
- 同一词条整卷最多作为干扰项出现一次；同一译文作为干扰项整卷最多出现 2 次。
- 20 个题干词条均不作为干扰项；每题 4 个译文互不相同。
- 在满足全部规则的前提下，整卷 60 个干扰项的总难度差最小（最小费用流全局优化，
  而非逐题贪心）。只有整卷确实不存在合法分配时才返回 `{ ok: false }`。

## 构建与测试

```sh
npm install
npm test
```

依赖仅有开发依赖 `typescript`；测试使用 Node 内置 `node:test`，无需其他服务。
