# CortexNLU 内存短语检索

基于同义替换的内存短语检索组件（TypeScript）。

## 用法

```ts
import { buildIndex, search } from "./src/index.js";

const index = buildIndex(
  [{ id: "m1", text: "wifi support" }],
  [{ left: "wifi", right: "wireless network" }],
);
search(index, "network support"); // ["m1"]
```

## 语义

- 消息、规则、查询统一转小写，按连续 ASCII 字母/数字分词，其余字符仅作分隔。
- 每条同义规则两侧各 1–3 个 token，双向生效。
- 匹配时在原消息 token 序列上选择若干互不重叠的区间做一次性替换；
  替换结果不会再次触发规则，也不计算传递闭包。
- 查询的完整 token 序列在至少一种合法改写中连续出现即命中。
- 索引构建后不可变（深度冻结）。

## 开发

```sh
npm install
npm test      # 编译并运行 node:test 测试
npm run build # 仅类型检查
```
