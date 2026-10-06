# sales-scoring

销售评分重算模块（TypeScript 库）。评分与计算状态保存在内存中，初始数据由调用方提供；
只处理一个团队的当前周期。

## 构建与测试

```sh
npm install
npm test        # 编译 src/ 并运行 node:test 测试
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { ScoringEngine } from "sales-scoring";

const engine = new ScoringEngine({
  categories: ["cat0", /* …固定 10 个类别，顺序不变 */],
  weights: [1000, /* …10 个正整数，合计 10000（1 单位 = 0.01pp）*/],
  previousComposites: { alice: 2.5 }, // 上一周期综合分，可缺失，不再修改
});

// 批量录入/修订完整评分（每项 1..5 整数），同批全部同时生效，任一非法则整批拒绝
engine.submitScores([{ memberId: "alice", scores: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3] }]);

// 替换权重：完成时一次性发布；发布前查询仍用旧权重；
// 重算期间成功提交的修订会被新权重采用，不会丢失
await engine.replaceWeights([4000, 2000, 500, 500, 500, 500, 500, 500, 500, 500]);

engine.getTeamAverage();        // 已评分成员的综合分均分；无人评分时为 null
engine.getMemberResult("alice"); // { composite, percentile, coachingEligible, coachingTargets }
engine.getSnapshot();           // 当前派生状态的不可变快照
```

## 规则摘要

- 综合分 = Σ(评分 × 权重) / 10000，排名与资格判断使用未四舍五入的值。
- 百分位 = 100 × (低于该分人数 + 同分人数 / 2) / 已评分人数；同分者百分位相同；
  只有一人或全员同分时为 50。未评分成员不参与均分和排名。
- 辅导资格：上一周期与当前周期综合分都严格低于 3.0；上一周期缺失不算连续低分。
  目标类别为当前周期原始评分最低的两个类别，并列按固定类别顺序选取。
- 每次查询读取单一不可变快照，均分、百分位、资格与目标不会混用不同状态。
