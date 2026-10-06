# inference-gateway

本地模型网关的推理调度库（TypeScript）：处理端点退化时的等待队列重路由，
以及取消、超时与执行完成之间的交错。

## 构建与测试

```sh
npm install
npm test        # = tsc && node --test "dist/*.test.js"
```

只依赖 Node.js（>= 18）与 devDependencies 中的 `typescript`、`@types/node`。

## API

```ts
import { InferenceGateway } from "./dist/gateway.js";

const gateway = new InferenceGateway(
  [
    { id: "m1", capabilities: ["chat"], execute: async (req, signal) => "..." },
  ],
  scheduler?, // 可选：注入单调时钟与计时器 { now, setTimeout, clearTimeout }
);

const outcome = await gateway.submit({ id: "r1", capability: "chat" }, abortSignal);
// outcome: { status: "completed", value }
//        | { status: "failed", reason: "cancelled" | "timeout" | "no-capacity" | "execute-error" }

gateway.reportHealth("m1", false); // 连续 3 次失败 -> 退化；1 次成功 -> 清零并恢复
const snap = gateway.snapshot();   // 各模型健康状态、占槽请求、按执行顺序的等待 id
```

## 调度规则

- 每模型 1 个执行槽 + 20 个等待位置；择路选「占槽 + 等待」最小者，同值按模型 id 字典序。
- 无可接纳模型时立即以 `no-capacity` 拒绝，无隐藏溢出队列。
- 模型退化时，未执行请求在 `reportHealth` 返回前按首次提交顺序重新归属或失败；
  迁移请求与目标队列按首次提交顺序合并。
- 等待期限固定为首次 submit 后 45 秒，迁移/恢复不刷新；到期未执行即超时。
- 取消运行中的请求会立即结束调用方等待并通知 execute，但槽位在 execute
  真正返回后才释放。

## 结构

- `src/types.ts` — 公共类型（请求、模型定义、结果、时钟接口、快照）
- `src/gateway.ts` — `InferenceGateway` 调度实现
- `src/testkit.ts` — 测试工具：`FakeScheduler`（虚拟时间）、`ManualExecute`（手动完成的执行 Promise）
- `src/*.test.ts` — node:test 测试：迁移合并与溢出、超时交错、取消与槽位释放、择路/健康恢复
