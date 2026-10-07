# task26100932

进程内留任奖金账本（TypeScript，零运行时依赖）。

## 使用

```ts
import { RetentionBonusLedger } from './src/index.ts';

const ledger = new RetentionBonusLedger();

ledger.recordEmployment(referralId, revision, hiredAt, endedAt, bonusCents);
ledger.approve(commandId, referralId, at);
ledger.pay(commandId, referralId, at);
const view = ledger.read(referralId, at, knownSeq);
```

- 所有时间为 UTC 毫秒时间戳；`endedAt` 可为 `null`。
- 成功写入获得全局递增 `seq`；重复事实（同 referralId + revision）与重复命令（同 commandId）返回原收据。
- `read` 仅使用 `seq <= knownSeq` 且 `at` 不晚于查询时刻的信息，取前缀内最大 revision 的修订。
- 连续 90 个 24 小时全额归属；离职早于门槛永不归属，恰好等于门槛归属。
- 每份推荐终身只能成功付款一次；`clawbackCents` 为已付款超过归属的部分。

## 开发

```sh
npm install   # 仅安装 devDependencies（typescript、@types/node）
npm test      # node --test，直接运行 TypeScript（Node >= 22.6）
npm run typecheck
```
