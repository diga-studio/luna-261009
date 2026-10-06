# drill-scoring

演练评分组件：把参与者提交的响应动作分配给检查清单步骤，基于**全局最优**的证据分配计算评分，并解释哪些遗漏是必然缺口。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

只依赖 Node.js 与 `devDependencies` 中的 TypeScript，不需要任何外部服务。

## API

```ts
import { evaluate, explainGap } from "./src/evaluator";
```

- `evaluate(spec, actions)` — 计算最高评分，返回 `{ assignment, uncoveredStepIds, Q, score }`：
  - `assignment`：`actionId -> stepId` 的证据映射（一条动作至多证明一个步骤，一个步骤至多使用一条动作）；
  - `uncoveredStepIds`：该最优映射下未覆盖的步骤；
  - `Q`：最优整数目标值，`score = Q / (W * R)`。
- `explainGap(spec, actions, stepId)` — 判断指定步骤能否在**某个**全局最优方案中被覆盖（结论不依赖 `evaluate` 碰巧选中的同分映射）：
  - `{ status: "coverable-in-optimal", assignment, Q, score }`：可以，附一个覆盖它且同分最优的映射；
  - `{ status: "requires-score-drop", maxQ, maxScore }`：不能同分覆盖，给出强制覆盖它时可达到的最高 `Q`；
  - `{ status: "infeasible" }`：完全无法覆盖（没有任何合法动作能证明该步骤）。

## 匹配与评分规则

动作 `a` 能证明步骤 `s` 当且仅当：`s` 在 `a.candidateStepIds` 中、阶段相同、NIST 标签相同、
参与者角色（来自 `spec.participantRoles` 的可信映射）被 `s.allowedRoles` 允许，
且 `0 <= elapsedMs < durationMs`。

- 及时档位 `q = 10 - floor(10 * elapsedMs / durationMs)`；
- `Q = (60*C + 3*T) * R + 10*W*V`，其中 `C` 为已覆盖步骤权重和、`T = Σ w_s * q`、
  `W` 为全部步骤权重和、`R = |requiredRoles|`、`V` 为已使用证据中出现的 requiredRoles 角色数
  （按不同角色计数，不按动作数或人数）。

## 实现要点

- 单条动作→步骤的边权为 `w_s * (60 + 3q)`，即对 `60C + 3T` 的贡献；
- 角色奖励 `10*W*V` 是整个演练共享的覆盖奖励，不能折进单边权重。由于角色只有
  `Director` / `Responder` 两种，枚举 requiredRoles 的每个子集 S（“恰好被使用的 required 角色集合”）：
  禁止 S 外的 required 角色、强制 S 内每个角色至少出现一次，对每种情形求最大权二分匹配
  （Hungarian 算法），取 `Q` 最大者；
- `explainGap` 独立枚举“覆盖目标步骤的见证边”，在剩余图上做同样的最优求解，
  因此结论不依赖 `evaluate` 的同分选择。
