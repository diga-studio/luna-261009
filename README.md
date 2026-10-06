# CortexNLU 内存短语检索组件

TypeScript 实现的内存短语检索：支持双向多词同义替换，且不会制造不存在的相邻关系。

## 使用

```ts
import { buildIndex, search } from "./src";

const index = buildIndex(
  [{ id: "m1", text: "wifi support" }],
  [{ left: "wifi", right: "wireless network" }]
);
search(index, "network support"); // ["m1"]
```

## 语义

- 消息、规则、查询统一转小写，连续 ASCII 字母/数字提取为 token，其余字符仅作分隔。
- 每条规则两侧各 1-3 个 token，双向生效；构建时校验，违规抛错。
- 匹配：在原消息 token 序列上选取互不重叠的区间，各匹配一条规则的一侧并整体替换为另一侧，其余保留；允许完全不替换。
- 规则只作用于原序列，替换结果不再触发规则，不计算传递闭包。
- 查询自身不扩展；其完整 token 序列在至少一种合法改写中连续出现时该消息命中。
- 索引构建后冻结不变，`search` 只读。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 先用本地 `tsc` 编译，再以 `node --test` 运行全部测试。
