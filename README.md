# CrashLens 截图断点续传组件

TypeScript 实现的可断点续传截图上传组件。元数据存 SQLite（`node:sqlite`，无原生依赖），
截图字节只存本地文件，二者通过"先落盘、后记元数据、重开清扫"的顺序保证崩溃一致性。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js >= 22.5（`node:sqlite`）与 devDependencies 中的 `typescript` / `@types/node`。

## API

```ts
import { ScreenshotUploadService } from './src';

const svc = new ScreenshotUploadService(storageDir);
svc.begin(uploadKey, ticketId, [{ byteLength, sha256 }, ...]); // 1-5 张，同 key 同声明重试幂等
svc.putChunk(uploadKey, fileIndex, chunkIndex, bytes);          // 256 KiB 定块，可乱序，冲突拒绝
svc.commit(uploadKey); // committed | incomplete(缺块可续传) | failed(摘要不符，终态)
svc.inspect(uploadKey); // 批次状态 + 已接受分块 + 该工单全部已发布附件
svc.close();
```

## 崩溃一致性设计

- `PutChunk`：临时文件 + fsync + rename 落盘后才写 chunks 表；崩溃留下的孤儿分块文件
  在重开时清扫，Inspect 不会声称其已接受。
- `Commit`：先把全部分块组装到 staging 并实际计算 SHA-256 校验（绝不凭声明摘要跳过），
  全部通过后才逐个发布到 `attachments/<ticket>/att_<sha256>`（内容寻址，天然去重），
  最后在单个 SQLite 事务里写附件行 + 批次终态。任何时刻崩溃，重开后续传或重试 Commit
  都收敛到同一组附件标识；重复 Commit 返回已存的终结结果。
- 终态批次（committed/failed）的分块、staging 候选与无引用文件在终结时及下一次重开时清理；
  仍可续传批次的已确认分块保留。

## 测试

`npm test` 编译后以 `node:test` 运行。崩溃用真实子进程 + SIGKILL 在服务内部的
持久化边界暂停点（`CommitHooks`，仅测试用）触发，不使用 sleep 或异常模拟。覆盖：

- 乱序分块在 SIGKILL 后续传，相同重试幂等、冲突重试拒绝；
- 双文件批次在 staging 后 / 发布与记录之间 / 记录后返回前三个边界崩溃，验证全有或全无与标识稳定；
- 跨批次同内容去重为一份文件、损坏字节重传被拒、含错误摘要批次整体失败且无新增附件；
- 重开清扫孤儿文件但保留可续传分块。
