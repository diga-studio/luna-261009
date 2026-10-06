# 演练评分组件

把参与者提交的响应动作按全局最优分配给检查清单步骤，并解释哪些遗漏是必然缺口。

## 使用

```bash
npm install
npm test        # vitest
npm run build   # tsc -> dist/
```

## API

- `evaluate(spec, actions)`：最大化整数目标 `Q = (60*C + 3*T) * R + 10*W*V`，
  返回 `{ Q, score, mapping, uncoveredStepIds }`。
- `explainGap(spec, actions, stepId)`：判断指定步骤能否在某个全局最优方案中被覆盖。
  - `covered-in-optimum`：返回一个覆盖它且同分最优的映射；
  - `forced-suboptimal`：返回强制覆盖它时可达到的最高 `maxQ` 及对应映射；
  - `infeasible`：任何合法方案都无法覆盖该步骤。

## 实现要点

- 匹配合法性：步骤在动作候选列表中、阶段一致、NIST 标签一致、参与者角色被步骤允许，
  且 `0 <= elapsedMs < durationMs`。
- 全局最优通过最小费用流求解（`src/matching.ts`）：
  `source -> role -> action -> step -> sink`，每个角色节点带一条容量 1、
  费用为 `-10*W`（角色在 `requiredRoles` 中时）的首用奖励边；
  沿最短路增广直到最短路非负，即得任意流量下的最大收益。
- `explainGap` 通过枚举“哪条动作证明该步骤”并固定该边后重解，
  与无条件最优值比较，结论不依赖 `evaluate` 碰巧选中的同分方案。
