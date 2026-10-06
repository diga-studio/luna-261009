# sms-delivery-scheduler

离线短信投递排程库（TypeScript）。由上层营销应用调用，全部状态保存在内存，
使用模拟时钟推进，不依赖真实时间、网络或任何外部服务。

## 使用

```ts
import { SmsScheduler } from "sms-delivery-scheduler";

// 以起始 UTC 时刻创建排程器
const scheduler = new SmsScheduler("2026-01-10T13:00:00Z");

// 提交消息（仅登记，不执行）。outcomes 为各次尝试的预设结果，最多 3 个。
const id = scheduler.submit({
  contactId: "customer-123",
  templateId: "cart-reminder",
  scheduledAt: "2026-01-10T13:00:00Z",
  outcomes: ["failure", "success"], // 第一次失败，第二次成功
});

// 推进模拟时钟到目标 UTC 时刻（含该时刻），期间执行所有可行尝试
scheduler.advanceTo("2026-01-11T13:00:00Z");

// 查看结果
scheduler.getMessage(id);    // 单条消息状态与尝试记录
scheduler.listMessages();    // 全部消息
scheduler.listAttempts();    // 全部尝试记录（按发生顺序）
```

## 投递规则

- 所有联系人固定使用 America/New_York 时区；每天当地时间 08:00（含）至
  21:00（不含）允许尝试，自动遵循夏令时。
- 每个联系人在任意滚动 24 小时内最多 6 次尝试（含失败与重试）；
  恰好发生在 24 小时前的尝试不再占额度。
- 同一联系人、同一模板的两条不同消息，首次尝试至少间隔 4 小时
  （无论首次成功或失败）；重试不受此限制。
- 每条消息最多尝试 3 次。首次失败后至少等 60 秒，第二次失败后至少等
  120 秒（从前一次实际尝试时刻算起）；第三次失败后标记为 `exhausted`，
  成功后标记为 `delivered`。
- 滚动 24 小时、4 小时去重与重试等待均按 UTC 实际经过时长计算。
  被限制挡住的消息只延后，不丢弃、不合并。
- 推进期间只要存在满足全部限制的消息就不闲置；多条同时可行时，
  先按本次最早预约时间（首次用原预约时间，重试用上次实际尝试时间加
  等待时长）排序，再按提交顺序排序；每次尝试后重新评估。
- 同一批提交与预设结果，一次推进与分段推进的最终尝试顺序、
  实际 UTC 时间与消息状态完全一致。
- 预设结果不足 3 个而消息仍需重试时，超出的尝试按失败处理。

## 构建与测试

```sh
npm install
npm test
```

只需要 Node.js；`npm test` 会先编译 TypeScript 再运行 `node --test`。
