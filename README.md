# PipeLite 分组投递内核

嵌入式 TypeScript 库：单队列、多消费组（1–8 个，初始化时固定）的独立分组投递，
消息与投递状态持久化在 SQLite（Node 内置 `node:sqlite`，无任何运行时依赖）。

## 要求

- Node.js >= 22.5（提供 `node:sqlite`）
- 开发依赖仅 `typescript`：`npm install` 后 `npm test` 即可构建并运行全部测试

## API

```ts
import { PipeLite } from 'pipelite';

const pl = new PipeLite({
  path: 'queue.db',          // SQLite 文件路径，或 ':memory:'
  groups: ['mail', 'audit'], // 1–8 个消费组，初始化后固定
  clock: () => Date.now(),   // 上层提供的非递减逻辑时钟（毫秒）
});

const id = pl.enqueue({ hello: 'world' }, 5); // 载荷为 JSON，优先级 1–10

const batch = pl.claim('mail', 50);  // 领取 1–50 条：优先级高者优先，同级按入队先后
for (const msg of batch) {
  // msg.payload / msg.receipt / msg.expiresAt（领取起 30 秒有效，到期时刻本身已失效）
  pl.ack('mail', msg.receipt);       // 迟到/非法/他组回执返回 false，不产生副作用
}

const status = pl.status(id);        // 该消息在各组的 state 与 attempts
pl.close();
```

## 语义要点

- 每条消息独立投递给每个组；组间状态、尝试次数互不影响。
- 尝试次数按（消息, 组）独立计数，仅在成功领取时 +1；前四次超时重新可领取，
  第五次超时进入该组死信，及时确认仍算完成。
- 回执仅代表本组本次投递：过期回执、被重新领取后的旧回执均不能确认消息，
  重复确认无额外效果。
- 所有操作在单个 `BEGIN IMMEDIATE` 事务内完成，并先按当前时间落地到期效果
  （不依赖后台清理）；同进程多实例可安全共享同一数据库文件。
- 正常 `close()` 后重开，消息、各组状态、尝试次数与未到期回执全部保留
  （WAL + `synchronous=OFF`，不保证异常终止恢复）。

## 测试

`npm test`：编译后运行 `node:test` 套件，覆盖领取顺序与竞争、到期边界与新旧回执
交错、组间独立性与死信、关闭重开持久化，以及 10000 消息 × 8 组 × 每组 8 消费者的
规模场景（与按规则独立推导的参考模型全量比对）。

## 目录

- `src/types.ts` — 公开类型
- `src/schema.ts` — SQLite 建表语句
- `src/pipelite.ts` — 内核实现
- `typings/node-shims.d.ts` — 对所用 Node 内置模块的最小类型声明（替代 `@types/node`）
- `test/` — 自动化测试
