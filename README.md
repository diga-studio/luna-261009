# discipline-history

封账周期纪律历史回溯库（TypeScript，进程内数据）。供上层治理系统直接调用：
一个实例负责一个领导、一个评价周期，支持装载完整资料、撤销处罚（成功申诉）、
查询周期内任意时点处理完全部变化后的纪律状态。

## 使用

```ts
import { DisciplineHistory, DisciplineState } from "discipline-history";

const h = new DisciplineHistory(periodStart, periodEnd); // 不可变窗口 [start, end)，整数 UTC 秒
h.load({ penalties, directives });                        // 完整资料，仅装载一次
h.revokePenalty("penalty-id");                            // 撤销处罚；重复/未知编号返回 false
const state = h.query(t);                                 // => DisciplineState
```

四种状态：`None` 无处分、`Review` 审查中、`Punishment` 处分中、`Resolved` 已解决。

## 语义要点

- 人工指令只允许 `None→Review→Punishment→Resolved→None` 相邻跳转；
  进入 `Punishment` 还要求该秒至少有一条有效且未撤销的处罚。
  不满足前提的指令保留但忽略。
- 同一秒先按处罚区间求覆盖，再执行必要的自动转换（处分中且覆盖归零 → 审查中），
  最后按序号升序处理人工指令。首尾相接的处罚不产生瞬间空档；覆盖恢复不自动升级。
- 撤销表示该处罚在整个周期内从未提供过处分资格：所有人工指令按更正后的事实
  重新判定，以前忽略的指令可能重新生效。
- 查询结果与"使用当前未撤销处罚从周期起点完整回放"严格一致。

## 实现

`src/timeline.ts` 把周期内全部事件点（处罚边界、指令时间、周期起点）压缩为
时间轴叶子，每个叶子保存该秒的状态转移函数（4 状态上的映射），内部节点保存
子区间函数的复合。撤销 = 覆盖计数区间减一；计数只减不增，每个叶子最多翻转一次
零覆盖形态。查询 = 前缀函数复合作用于初始状态。

- 装载：`O((P+D) log(P+D))`
- 撤销：均摊 `O(log(P+D))`（全部撤销的总翻转次数不超过事件点数）
- 查询：`O(log(P+D))`

## 测试

```sh
npm install
npm test
```

- `test/rules.test.ts`：业务规则（首尾相接、同秒多指令、撤销重判、覆盖恢复不升级等）
- `test/fuzz.test.ts`：随机小规模资料，每次撤销后与独立的逐秒从头回放全量对拍
- `test/stress.test.ts`：10 万处罚 + 10 万指令，装载后连续撤销 2 万次、每次查 5 个时点；
  断言总耗时 ≤ 30 s、峰值内存 ≤ 512 MiB，且 ≥ 1000 次撤销实际改变查询结果
  （本机实测约 0.15 s / 158 MiB / 2000 次有效撤销）
