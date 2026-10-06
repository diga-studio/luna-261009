# smartdesk-branch-matcher

SmartDesk 对话树分支匹配库。上游已选定当前节点并完成 FAQ 检索，本组件负责把客户消息路由到该节点的一个分支。

## 使用

```ts
import { compile, match } from "smartdesk-branch-matcher";

const matcher = compile([
  { id: "greet", keywords: ["你好"], patterns: ["^(hi|hello)$"] },
  { id: "bye",   keywords: ["再见"], patterns: [] },
]);

match(matcher, "你好呀"); // { branchId: "greet", start: 0, end: 2 }
match(matcher, "嗯");     // null
```

- `compile(branches)` 返回可复用的匹配器。每个分支有 `id`、`keywords`、`patterns`，数组顺序用于最终平局裁决。
- `match(matcher, text)` 返回命中的分支及匹配区间，未命中返回 `null`。位置按 Unicode 码点计数，区间左闭右开。

## 匹配语义

- 关键字按字面子串匹配；关键字和表达式均区分大小写，不做 Unicode 规范化。
- 表达式支持：字面字符、圆括号分组、选择符 `|`、量词 `*` `+` `?`、通配符 `.`、
  字符类 `[abc]`、`[^abc]`、按码点排序的范围 `[a-z]`、锚点 `^` `$`、反斜杠转义。
  量词可作用于字符、字符类或分组，分组可嵌套。分组不产生捕获；
  不支持简写字符类（如 `\d`）、回溯引用、环视、懒惰量词，遇到即在 `compile` 时抛错。
- 通配符包含换行；`^` `$` 只匹配整条消息的开头和结尾。所有字符操作以 Unicode 码点为单位。
- 候选裁决：先选起点最小，再选终点最大，最后选声明顺序最早的分支。表达式中的选择顺序不影响结果。
- 零长度命中不参与选择，但能匹配空串的合法表达式（如 `a?`）可以正常编译。

## 实现与复杂度

表达式经递归下降解析为 AST（`src/parser.ts`），再编译为 Thompson NFA（`src/nfa.ts`），
用 Pike VM 方式模拟执行：对每个起点做 epsilon 闭包并逐码点推进线程集，
记录该起点的最长接受位置，天然得到「起点最小、终点最大」语义，且与选择符顺序无关。
匹配器为不可变数据，`match` 是纯函数，可安全并发、反复使用。

记消息码点数为 `n`，某表达式 NFA 指令数为 `m`，关键字为 `k`（长 `L`）：

- `compile`：每个表达式 O(m)（解析 + 编译各一遍）。
- 关键字查找：O(n·L)（朴素子串扫描，只取首次出现）。
- 表达式匹配：每个起点 O(n·m)，全部起点共 O(n²·m)；
  闭包用 visited 集合去重，`(a*)*` 等 nullable 循环不会死循环。
- 单次 `match` 总体：O(Σ关键字 n·L + Σ表达式 n²·m)。
  对话树节点分支数与消息长度都很小，该复杂度实际开销可忽略；
  若未来需要处理长文本，可把多表达式合并为单个 NFA 一次扫描降到 O(n·Σm)。

## 开发

```sh
npm install   # 仅 devDependencies：typescript、@types/node
npm test      # 先 tsc 构建到 dist/，再用 node:test 跑 dist/test/*.test.js
```
