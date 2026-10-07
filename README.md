# task26100936

块内碎片预算规划器（TypeScript）：把破碎层级（森林，每棵树代表一个可破坏物体）
转换成最多 200 个活动碎片，在所有合法切面中取得精确的全局最小细节损失；
损失并列时取最小切换数量。

## 构建与测试

```sh
npm install
npm test
```

只需要 Node.js；`npm test` 会用 `tsc` 编译到 `dist/` 并运行 Node 内置测试器。

## API

```ts
import { createChunkPlanner } from "./src/planner";

const planner = createChunkPlanner(forest); // 初始活动切面为所有根节点
planner.updateErrors([{ id: 12, error: 340 }]); // 覆盖指定节点的 error
const { selected, totalError, switches } = planner.plan();
```

- `forest`：根节点数组（≤ 200 个根，总节点 ≤ 20000，深度 ≤ 8）。节点含块内唯一
  `id` 与非负整数 `error`（≤ 1e9；叶节点为 0；父节点不小于直接子节点之和）。
- `plan()` 返回选中节点 id 集合 `selected`、总损失 `totalError`、相对上一次
  返回切面的切换数量 `switches`，并把本次切面设为下一次的基准。
- 每条根到叶路径恰好包含一个选中节点；总损失在所有不超过预算的合法切面中
  精确最小；并列时切换数量最小。

## 算法

按节点做树形 DP：`f(node, k)` 为子树内恰好用 k 个碎片的最小目标键，
`k = 1` 取「以本节点代理」与「沿单子链上传的最优」的较小值，`k ≥ 2` 为子节点
行的有界背包合并；森林层再对所有根做一次背包。目标键把
`总损失 * 1024 + 切换惩罚` 编码进单个可精确比较的数（切换惩罚 ∈ [-200, 200]），
从而一次 DP 同时实现损失最小与切换数最小的字典序优化。回溯时重算局部分配，
不枚举任何切面集合。复杂度约 `O(预算 × 深度 × 节点数)`，20000 节点一次规划
约 25ms，额外内存约 11MB（远低于 128MiB）。
