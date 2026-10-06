# dns-codec

一个零依赖的 DNS 报文编解码库（TypeScript），供本地解析引擎直接调用。

## 功能

- `decode(packet)`：把一条完整 DNS 报文（`Uint8Array`）解析为逻辑消息
  （头部、1 个 question，以及 Answer / Authority / Additional 三节）。
- `encode(message, maxBytes = 65535)`：把逻辑消息编码为不超过 `maxBytes`
  字节的完整 DNS 报文。超限时按 Additional → Authority → Answer 的顺序、
  以 RRset（同节、忽略 ASCII 大小写的 owner + type + class）为单位整组移除，
  并置 TC；头部和 question 都放不下时抛 `EncodeError`，绝不返回残缺报文。

## 消息模型

```ts
type Name = Uint8Array[];           // 原始标签字节，保留边界、大小写与任意字节

interface DnsMessage {
  header: Header;                   // id/qr/opcode/aa/tc/rd/ra/z/rcode
  question: Question;               // qname/qtype/qclass，恰好 1 个
  answers: ResourceRecord[];        // 顺序保留
  authorities: ResourceRecord[];
  additionals: ResourceRecord[];
}
```

支持的记录类型：A、AAAA、CNAME、MX、TXT、PTR、SRV；其他类型在解码时明确拒绝。
域名在逻辑层是原始标签字节数组（不是字符串），标签内的点号、零字节、
非 ASCII 字节都按原样保留；TXT 保留原始分段。

## 约束要点

- 压缩指针只指向报文中更早的标签边界（偏移 ≤ 16383），后缀匹配大小写敏感；
  SRV 的 target 不压缩。解码拒绝循环/前向指针、非法标签标记、超长展开名。
- RDLENGTH 必须恰好被 RDATA 填满；TXT 分段越界、RDATA 越界均稳定失败。
- 裁剪后从头重新编码，长度、计数、压缩引用全部重新计算。

## 使用

```ts
import { decode, encode } from "dns-codec";

const message = decode(packet);
const out = encode(message, 512); // 超过 512 字节时按规则裁剪并置 TC
```

## 开发

```sh
npm install
npm test   # 先 tsc 构建，再用 node:test 跑 dist/test 下的全部测试
```
