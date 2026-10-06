# split-route-compiler

把同一用户所属各组的分流规则合成为一张独立的最长前缀匹配路由表。
组成员关系由调用方确定；本库只负责规则编译与查询。

## 语义

- 每条规则为 `{ cidr, route }`，`route` 取 `"tunnel"` 或 `"direct"`。
- 支持 IPv4 与 IPv6，两种地址族独立处理；输入 CIDR 需已按网络地址对齐，同组内无重复 CIDR。
- 每组内按最长前缀匹配求值，无匹配为 `"direct"`。
- 跨组合并：任一组结果为 `"tunnel"` 则最终为 `"tunnel"`，否则为 `"direct"`。
  因此某组的宽泛隧道路由可被**本组**更具体的直连规则覆盖，但不会被**另一组**的直连结果覆盖。
- `compile` 输出的路由表同样是最长前缀匹配、默认 `"direct"`，且对任意地址的
  判定结果与逐组求值完全一致。

## API

```ts
import { compile, decide } from "split-route-compiler";

const table = compile([
  [
    { cidr: "10.0.0.0/8", route: "tunnel" },
    { cidr: "10.1.0.0/16", route: "direct" }, // 本组直连洞覆盖本组隧道
  ],
  [{ cidr: "10.1.0.0/17", route: "tunnel" }], // 另一组覆盖洞的一部分
]);

decide(table, "10.1.0.1");   // "tunnel"（另一组的隧道不受本组直连影响）
decide(table, "10.1.128.1"); // "direct"（两组均为 direct）
decide(table, "2001:db8::1"); // "direct"（无匹配，默认 direct）
```

- `compile(groups: Rule[][]): Rule[]` — 合成独立路由表。
- `decide(table: Rule[], address: string): Route` — 仅依据传入路由表判定单个地址。

## 构建与测试

```sh
npm install
npm test
```

`npm test` 先运行 `tsc` 构建到 `dist/`，再用 Node 内置测试运行器执行
`dist/test/*.test.js`。唯一开发依赖是 `typescript`；测试通过
`test/shims.d.ts` 提供 `node:test` / `node:assert` 的最小类型声明，
无需 `@types/node`。
