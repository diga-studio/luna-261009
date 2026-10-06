# task26100916

DNS 报文编解码库（TypeScript）：在字节报文与逻辑消息之间转换，并按字节预算生成完整响应。

## 使用

```ts
import { decode, encode, DnsMessage } from "dns-codec";

const msg: DnsMessage = decode(packet);        // Buffer -> 逻辑消息
const out: Buffer = encode(msg);               // 默认 maxBytes = 65535
const small: Buffer = encode(msg, 512);        // 超限时整组移除 RRset 并置 TC
```

- 消息模型包含 `header`、单个 `question`，以及 `answers` / `authorities` / `additionals` 三节。
- 域名表示为原始标签字节数组（`Buffer[]`），保留标签边界、大小写与任意字节内容；TXT 保留原始分段。
- 仅支持 A、AAAA、CNAME、MX、TXT、PTR、SRV 七种记录，其他类型抛出 `DnsError`。
- 编码时自动使用域名压缩（大小写敏感；SRV target 按 RFC 2782 不压缩）；超过 16383 的偏移不作为压缩目标。
- 超出 `maxBytes` 时依次从 Additional、Authority、Answer 移除整个 RRset（同节内按最后出现位置从后往前），发生移除即置 TC；头部加 question 都放不下时抛错，绝不返回残缺报文。
- 解码拒绝循环/前向压缩指针、非法标签标记、超长展开名、RDLENGTH 不匹配及 TXT 分段越界。

## 构建与测试

```sh
npm install
npm test        # tsc 构建后运行 node:test 测试
```
