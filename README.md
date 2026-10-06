# model-gateway-scheduler

本地模型网关的推理调度库（TypeScript）。负责在多个进程内模型端点之间择路派发请求，
处理端点退化时的等待队列重路由，以及取消、等待超时与执行完成之间的交错。

## 使用

```ts
import { ModelGateway } from "./src/gateway.js";

const gateway = new ModelGateway({
  models: [
    { id: "m-a", capabilities: ["chat"], execute: async (req, signal) => { ... } },
    { id: "m-b", capabilities: ["chat", "embeddings"], execute: async (req, signal) => { ... } },
  ],
  // 可选注入：clock / scheduler / waitTimeoutMs(默认 45000) / maxWaitingPerModel(默认 20)
});

const result = await gateway.submit({ id: "req-1", capability: "chat" }, abortSignal);
gateway.reportHealth("m-a", false); // 连续 3 次失败标记退化并迁移等待队列
const state = gateway.snapshot();   // 各模型健康状态、占槽请求、等待队列（按执行顺序）
```

`submit` 返回的 Promise 以 `TerminalReason` 终结且仅终结一次：
`completed` / `cancelled` / `timedOut` / `rejected(no-capacity)` / `failed`。

## 调度规则

- 择路只看健康、能力匹配、等待位未满的模型；按 `占槽 + 等待数` 最小选择，同值取 id 字典序最小。
- 每个模型 1 个执行槽 + 20 个等待位；无可接纳模型时立即拒绝，无隐藏溢出队列。
- 连续 3 次健康检查失败标记退化，等待中的请求按首次提交顺序同步重路由或失败；
  一次成功清零计数并恢复健康。已执行的请求不追溯、不取消、不重试。
- 等待期限固定为首次 submit 后 45 秒，迁移或恢复不刷新；到达截止时刻的请求不会再启动。
- 取消运行中的请求会立即终结调用方并通知 execute，但槽位直到 execute 真正返回才释放。

## 开发

```sh
npm install
npm test   # 清理并编译到 dist-test/，然后用 node:test 运行全部测试
```

测试使用虚拟时钟（`test/helpers.ts` 的 `VirtualTime`）与可手动完成的 execute Promise，
不依赖真实定时器。
