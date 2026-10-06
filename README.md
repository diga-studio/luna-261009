# task26100911

分流策略编译库：把同一用户所属各组的规则合成为一张独立的最长前缀匹配路由表。

## API

- `compile(groups: Rule[][]): Rule[]` — 每组内最长前缀匹配（默认 `direct`），
  组间合并时只要一组结果为 `tunnel` 最终即为 `tunnel`；返回等价的单张路由表。
- `decide(table: Rule[], address: string): "tunnel" | "direct"` — 仅依据传入路由表，
  按最长前缀匹配返回该地址的路由结果（默认 `direct`）。

```ts
import { compile, decide } from "split-route-compiler";

const table = compile([
  [
    { cidr: "10.0.0.0/8", route: "tunnel" },
    { cidr: "10.1.0.0/16", route: "direct" },
  ],
  [{ cidr: "10.1.2.0/24", route: "tunnel" }],
]);

decide(table, "10.2.0.1");   // "tunnel"（另一组的 direct 不能覆盖本组 tunnel）
decide(table, "10.1.2.7");   // "tunnel"
decide(table, "10.1.3.7");   // "direct"
```

IPv4 与 IPv6 独立处理；输入 CIDR 需已按网络地址对齐，同组不得有重复 CIDR。

## 构建与测试

```sh
npm install
npm test
```
