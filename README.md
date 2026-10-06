# task26100906

保护组可恢复计划切换库（TypeScript + SQLite）。

## 结构

- `src/orchestrator.ts` — 编排库：`createGroup` / `switchGroup` / `recover` / `inspect`。
  编排状态（组、成员、请求、指令计划与结果）存 SQLite（`node:sqlite`，零原生依赖）。
  等待执行器回复时不持有数据库事务；指令 ID 由 `(groupId, requestId, seq)`
  确定性派生，恢复时重放同 ID，由执行器去重。
- `src/executor.ts` — 本机 VM 执行器独立进程，独立 SQLite 持久化。
  只接受单台副本 start/stop；成功与永久拒绝均持久化，同 ID 重放返回原结果且不再生效。
  支持在生效前（`beforeApply`）与生效已持久化但回复前（`beforeReply`）暂停，
  便于测试精确终止进程。执行历史（含是否真正生效）落库可检查。
- `src/executorClient.ts` — 编排进程侧客户端（fork 执行器、IPC 通讯）。
- `src/switchWorker.ts` / `src/recoverWorker.ts` — 测试辅助：在可 SIGKILL 的
  子进程中执行 SwitchGroup / Recover。
- `test/switch.test.ts` — 子进程终止 + 可控暂停的恢复测试，核验全部副本状态、
  最终请求结果与完整执行历史（顺序、去重、拒绝无副作用）。

## 状态机

`STOP_SOURCE → START_TARGET → 翻转活动站点/DONE(success)`；
目标端任何启动被永久拒绝则 `STOP_TARGET → START_SOURCE → DONE(failure)`，
活动站点不变。任何目标端启动前整个源端已停止；回滚时全部目标副本停止后
才恢复源端，源端全员运行后才记录失败。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js（>= 22.5，使用内置 `node:sqlite` 与 `node:test`），无其他服务。
