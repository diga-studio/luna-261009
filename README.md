# 企业词汇测验组卷库

TypeScript 实现的内存组卷库：载入单个语种的词库，为指定的 20 个题干生成四选一词汇试卷。

## 使用

```ts
import { QuizPaperLibrary } from "vocab-quiz-paper-library";

const library = new QuizPaperLibrary();
library.loadWordBank(entries); // WordEntry[]：id / word / translation / tag / difficulty(1-5)

const result = library.generatePaper(stemIds); // 20 个题干词条 id
if (result.ok) {
  // result.questions：恰好 20 题，每题 4 个译文选项 + correctIndex
  // result.totalDifficultyGap：60 个干扰项与各自题干的难度差绝对值之和
} else {
  // 整卷范围内不存在满足全部约束的干扰项分配
}
```

## 组卷规则

- 每题 3 个干扰项与题干行业标签相同、难度差绝对值不超过 1，且译文与题干译文互不相同；
- 同一词条整卷至多作一次干扰项，同一译文整卷至多作两次干扰项（正确选项不占配额）；
- 20 个题干词条均不作为干扰项；选项均来自词库，不改写译文；
- 在整张试卷范围内用最小费用流协调分配，返回总难度差最小的合法试卷；
- 仅当整卷确实不存在合法分配时返回 `{ ok: false }`；非法输入（题干数量不为 20、id 重复或不存在）抛错。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 会先编译（`tsc`）再运行 `node --test`。
