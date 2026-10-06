# CrashLens 截图断点续传组件

TypeScript 实现的截图分块断点续传存储。元数据保存在 SQLite（`node:sqlite`，无原生依赖），
截图字节保存在本地目录，崩溃后重开同一目录即可恢复续传。

## 运行

```bash
npm install
npm test        # 编译并运行全部测试（含真实子进程 SIGKILL 崩溃恢复用例）
```

要求 Node.js ≥ 23.4（内置 `node:sqlite`，推荐 24 LTS）。除 `typescript` / `@types/node`（devDependencies）外无其他依赖。

## API

```ts
import { CrashLensStore } from "crashlens-upload";

const store = new CrashLensStore(dir);          // 打开/重建存储目录，自动恢复清理
store.begin(uploadKey, ticketId, files);        // files: [{ size, sha256 }]（1~5 张）
store.putChunk(uploadKey, fileIndex, chunkIndex, bytes); // 256 KiB 定块，末块按剩余长度，可乱序
const outcome = store.commit(uploadKey);        // committed | failed | incomplete（缺块，保持可续传）
const view = store.inspect(uploadKey);          // 批次状态 + 已接受分块 + 工单全部已发布附件
store.close();
```

- `begin`：相同 uploadKey + 相同声明重试幂等；变更声明抛错且不改原批次。
- `putChunk`：同位置同字节重试无副作用；不同字节抛错，原分块不被覆盖。
- `commit`：核对全部文件的实际长度与 SHA-256（不信任声明与既有同摘要附件）；
  成功返回按文件顺序的 `{ attachmentId, path }`；摘要不符整批进入失败态。
  成功与失败均不可逆，重复 `commit` 返回原终结结果。
- `inspect`：批次状态、已接受分块坐标、该工单当前全部已发布附件。

## 存储布局

```
<dir>/
  meta.sqlite        # 批次、分块记录、已发布附件（WAL, synchronous=FULL）
  chunks/<hash(key)>/fi-ci.part   # 已确认分块（先写临时文件 fsync 再 rename，再记元数据）
  tmp/               # 写分块临时文件与提交候选文件（重开即清空）
  attachments/<sha256>            # 最终附件，内容寻址，天然去重
```

## 崩溃恢复设计

- **分块**：临时文件写入 + fsync + 原子 rename + 目录 fsync，然后单语句插入元数据。
  崩溃只可能留下"有文件无记录"的孤儿，重开时按元数据清理；`inspect` 只信元数据，
  不会声称未确认的分块已接受。
- **提交**：先逐文件拼装候选并实际校验长度与 SHA-256；全部通过后候选文件 rename 进
  `attachments/`（内容寻址、幂等），再用**单个 SQLite 事务**发布附件行（按
  `(ticketId, sha256)` `INSERT OR IGNORE` 保证稳定标识）并写入批次终结结果。
  - 文件已落盘、事务未提交时崩溃：批次仍 `uploading`，分块保留，重试提交幂等重放，
    孤儿附件文件重开时清理 —— 不会部分发布。
  - 事务已提交、未返回时崩溃：`inspect`/`commit` 直接读出已持久化的终结结果，
    不会重试出第二组附件。
- **清理**：终结批次的分块立即删除；`tmp/`、终结批次分块目录、无引用附件文件至迟在
  下一次重开时清理；仍可续传批次的有效分块不会被误删。

## 测试

`npm test` 使用 `node:test`。崩溃用例通过**真实子进程**在测试专用暂停点
（`CrashHooks`：`afterChunkPersist` / `afterFilePersistBeforePublish` /
`afterPublishBeforeReturn`）`SIGKILL` 自杀实现，不模拟异常、不用 sleep 赌时序。覆盖：

- 乱序分块持久化中断后续传，相同重试无副作用、冲突重试拒绝；
- 两截图在"文件持久化与批次发布之间"及"提交生效后返回前"中断：无部分发布、标识稳定；
- 跨批次/同批次相同内容只保留一份最终文件；含摘要错误文件的批次提交失败且零新增附件。
