# task26100919

销售评分重算模块（TypeScript 库）。评分与计算状态保存在内存中，初始数据由调用方提供；只处理一个团队的当前周期。

## 使用

```ts
import { createScoreBoard } from "./src/index.ts";

const board = createScoreBoard({
  categories: ["c1", /* …固定 10 个类别，顺序不变 */ "c10"],
  weights: [1000, /* …10 项正整数，总和 10000 */ 1000],
  previousComposites: new Map([["m1", 2.8]]), // 上一周期综合分，可缺失
});

board.submitScores(new Map([["m1", [3, 4, 3, 4, 3, 4, 3, 4, 3, 4]]])); // 整批原子生效
board.replaceWeights([/* 新权重，完成时一次性发布 */]);

board.teamView();          // { scoredCount, average }
board.memberView("m1");    // { composite, percentile, coachingEligible, coachingTargets }
```

## 规则要点

- 综合分 = Σ(评分 × 权重) / 10000，排名与资格判断使用未四舍五入值（内部以整数放大值比较，避免浮点误差）。
- 百分位 = 100 × (低于该分人数 + 同分人数 / 2) / 已评分人数；同分相同，单人或全员同分为 50。
- 辅导资格：上一周期与当前周期综合分均严格低于 3.0；上一周期缺失不算。目标为当前周期原始评分最低的两个类别，并列按固定类别顺序。
- 未评分成员不参与均分与排名；同一批评分全部同时生效，任一非法整批拒绝；权重替换一次性发布，发布后查询全部使用新权重。

## 构建与测试

只依赖 Node.js（≥ 22.18，利用原生 TypeScript 类型剥离）：

```sh
npm install   # 安装 devDependencies（typescript、@types/node，仅用于类型检查）
npm test      # node --test，直接运行 TypeScript 测试
npm run typecheck  # 可选：tsc 严格类型检查
```
