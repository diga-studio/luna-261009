# task26100903 — SmartDesk 对话树分支匹配库

上游已选定当前节点并完成 FAQ 检索，本库负责把客户消息路由到该节点的一个分支。

## 用法

```ts
import { compile, match } from "./src/index.js";

const matcher = compile([
  { id: "greet", keywords: ["你好", "hi"] },
  { id: "order", patterns: ["^订[0-9]+号", "订单(查询|取消)"] },
]);

match(matcher, "订单查询"); // { branchId: "order", start: 0, end: 4 }
match(matcher, "在吗");     // null
```

- `compile(branches)` 返回可复用、无内部状态的匹配器；分支含 `id`、`keywords`、`patterns`，数组顺序用于最终平局裁决。表达式非法时在 `compile` 阶段抛错。
- `match(matcher, text)` 返回 `{ branchId, start, end }`，未命中返回 `null`。位置按 Unicode 码点计数，区间左闭右开。

## 匹配语义

- 关键词按字面子串匹配；关键词与表达式均区分大小写、不做 Unicode 规范化。
- 表达式支持：字面字符、分组 `(...)`（非捕获、可嵌套）、选择 `|`、量词 `*` `+` `?`（可作用于字符、字符类或分组）、通配符 `.`（含换行）、字符类 `[abc]` `[^abc]` 与按码点排序的范围 `[a-z]`、锚点 `^` `$`（只匹配整条消息的开头与结尾）、反斜杠转义（仅把元字符变为字面字符，不支持 `\d` 等简写）。
- 不支持：捕获、回溯引用、环视、懒惰量词、简写字符类。
- 裁决规则：全部关键词与表达式产生的候选中，先选起点最小，再选终点最大，最后选声明顺序最早的分支；表达式内选择支的书写顺序不影响裁决。
- 零长度命中不参与选择，但能匹配空串的合法表达式不会被拒绝。

## 实现与复杂度

表达式经递归下降解析为 AST（`src/parser.ts`），再以 Thompson 构造编译为 NFA（`src/nfa.ts`），匹配时对 NFA 做状态集模拟，不使用回溯，因此不存在指数级回溯风险。设消息长 `n` 个码点，某表达式编译后状态数为 `s`（`s = O(表达式长度)`）：

- 编译：`O(表达式长度)` 时间与空间。
- 单表达式匹配：对每个起点 `i` 做一遍模拟，单遍 `O(n·s)`，整体最坏 `O(n²·s)`；额外空间 `O(s)`。
- 关键词匹配：朴素字串搜索，单关键词 `O(n·k)`（`k` 为关键词码点数）。
- `match` 总成本为各分支、各关键词/表达式成本之和；匹配器只读，可安全并发复用。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 构建，再用 node:test 跑 dist/test 下的用例
```

仅依赖 Node.js 与 `devDependencies` 中的 `typescript`、`@types/node`。
