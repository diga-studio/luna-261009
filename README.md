# retention-bonus-ledger

进程内留任奖金账本（TypeScript，无外部服务依赖）。

## 使用

```bash
npm install
npm test
```

## API

- `recordEmployment(referralId, revision, hiredAt, endedAt, bonusCents)`：记录一次完整雇佣事实修订，`endedAt` 可为 `null`；相同 `referralId + revision` 的重复事实返回原收据。
- `approve(commandId, referralId, at)`：经理签核，仅在调用时已归属时成功，绑定当时选中的 revision。
- `pay(commandId, referralId, at)`：确认付款，需要当前 revision 的有效签核且当时已归属；每份推荐终身只能成功付款一次。
- `read(referralId, at, knownSeq)`：返回业务时刻 `at`、仅使用 `seq <= knownSeq` 信息的视图（状态、归属/已付/应追回金额）。

所有时间为 UTC 毫秒时间戳。连续 90 个 24 小时全额归属；离职早于门槛则永不归属，恰好等于门槛则归属。
