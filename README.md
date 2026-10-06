# PipeLite 分组投递内核

嵌入式 TypeScript 库：单体应用内多个业务模块（消费组）独立消费同一批消息，
消息与投递状态持久化在 SQLite 中。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部服务依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 使用

```ts
import { PipeLite } from "pipelite";

const lite = new PipeLite({
  path: "data/pipelite.db",      // SQLite 文件；同进程多实例可指向同一文件
  groups: ["order", "billing"],  // 1 至 8 个消费组，初始化后固定
  clock: () => logicalNowMs,     // 可选：上层非递减逻辑时钟（毫秒），缺省 Date.now
});

const id = lite.enqueue({ any: "json" }, 5);   // 优先级 1..10，返回消息 id
const batch = lite.claim("order", 50);         // 领取 1..50 条，优先级高者优先
for (const msg of batch) {
  const ok = lite.ack(msg.receipt);            // 30 秒内确认；迟到/重复/跨组回执无效
}
const states = lite.status(id);                // 该消息在各组的投递状态
lite.close();
```

## 语义

- 每条消息独立投递给每个组；各组的尝试次数、租约、确认、死信互不影响。
- 领取按优先级降序、同优先级按入队先后；重新投递保留原入队顺序。
- 领取后该组持有消息 30 秒；到期时刻本身已失效。旧回执不能确认新投递。
- 尝试次数按 (消息, 组) 独立计数，仅在成功领取时增加；第 5 次超时进入该组死信。
- 领取批次在单个 IMMEDIATE 事务中生效；同组同消息任意时刻最多一个有效回执。
- 正常关闭重开后保留消息、各组状态、尝试次数与未到期回执。

## 脚本

- `npm run build`：编译 TypeScript 到 `dist/`
- `npm test`：编译并运行全部测试（含 10000 消息 × 8 组 × 8 消费者的规模场景）
