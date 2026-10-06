# task26100915

离线短信投递排程库（TypeScript，纯内存状态，模拟时钟）。

## 使用

```ts
import { SmsScheduler } from "./src";

const scheduler = new SmsScheduler("2026-03-07T00:00:00Z"); // 起始 UTC 时刻

const id = scheduler.submit({
  contactId: "user-1",
  templateId: "order-confirm",
  scheduledAt: "2026-03-07T13:00:00Z", // 预约 UTC 时间
  outcomes: [false, true],             // 每次尝试的预设结果（最多 3 个）
});

scheduler.advance("2026-03-08T00:00:00Z"); // 推进模拟时钟，不等待真实时间

scheduler.getAttempts(); // 逐条尝试记录（按执行顺序）
scheduler.getMessages(); // 每条消息的状态：pending / delivered / exhausted
scheduler.now();         // 当前模拟 UTC 时刻
```

## 规则

- 提交只登记，`advance()` 时才执行尝试；同一批提交无论一次推进还是分段推进，结果完全一致。
- 静默窗口：America/New_York 当地 08:00–21:00 之外禁止尝试（遵循夏令时）。
- 频率限制：每个联系人任意滚动 24 小时内最多 6 次尝试；恰好 24 小时前的尝试不再占额度。
- 去重：同一联系人同一模板的两条消息，首次尝试至少间隔 4 小时（重试不受限）。
- 重试：每条消息最多 3 次尝试；首次失败后等 60 秒，第二次失败后等 120 秒；第三次失败后标记 `exhausted`。
- 滚动窗口、去重与重试等待均按 UTC 实际经过时长计算；被限制挡住的消息只延后，不丢弃。
- 多条消息同时可行时，先按本次最早预约时间（首试用原预约时间，重试用上次实际尝试时间加等待时长），再按提交顺序排序。

## 构建与测试

```sh
npm install
npm test
```
