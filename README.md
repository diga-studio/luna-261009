# resumable-upload-store

可恢复的分段上传库（TypeScript），由上层文件平台直接调用。
分段内容与临时数据放在本地目录，会话进度与完成结果存 SQLite（Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（内置 `node:sqlite`）
- `npm install` 后 `npm test` 即可运行全部测试

## 使用

```ts
import { UploadStore, CHUNK_SIZE } from 'resumable-upload-store';

const store = new UploadStore({ dir: '/var/lib/uploads' }); // 打开即自动恢复

// 1. 开始会话：调用方给定稳定会话标识、总字节数、整文件 SHA-256
store.startSession({ sessionId: 'design-psd-001', totalSize, sha256 });

// 2. 提交分段：固定 5 MiB（仅末段可更短），按零基序号定位，允许乱序
store.submitChunk('design-psd-001', 0, chunkBuffer);

// 3. 查询进度：已确认分段 + 是否完成
const progress = store.getProgress('design-psd-001');

// 4. 完成上传：校验齐全性、总长度与整文件 SHA-256，返回可读文件引用
const { fileRef } = store.complete('design-psd-001');

store.close();
```

## 语义

- **会话声明不可变**：重复 `startSession` 相同声明是空操作（不重置进度）；冲突声明抛 `DECLARATION_CONFLICT`。
- **分段重传**：同序号相同字节成功且不产生新副本；不同字节抛 `CHUNK_CONFLICT` 并保留原数据。该规则在会话完成后依然生效（分段哈希保留在 SQLite 中）。
- **完成校验**：全部分段确认、按序拼接字节数等于声明长度、实际 SHA-256 匹配才完成；已存在同校验值的完整文件不能绕过本会话校验（`INTEGRITY_MISMATCH`）。
- **完成引用**：重复完成（含跨重启）返回同一引用；不同会话相同内容共享同一份内容寻址文件（`files/<sha256>`）；完整文件以只读权限发布，不可改写。

## 崩溃恢复

- 分段写入：临时文件 + fsync + 原子 rename，再提交 SQLite（WAL, `synchronous=FULL`）。
- 完成发布：staging 拼接 + fsync，原子 rename 到 `files/<sha256>`，再标记会话完成。
- 重新打开存储目录即恢复：清理中断的临时/半成品写入、无主分段副本、已完成会话的分段副本和无主完整文件；保留未完成会话的已确认分段。
- 恢复与重试均为幂等，可再次被中断。

## 目录布局

```
<dir>/
  upload.db     SQLite：sessions + chunks（含已完成会话的分段哈希）
  tmp/          分段写入临时区
  chunks/<sessionId>/<index>  已确认分段（会话完成后清除）
  staging/      完成时的拼接临时区
  files/<sha256>  完整文件（内容寻址、只读）
```

## 测试

`npm test` 编译后运行 node:test 套件：

- `test/store.test.ts`：会话声明、乱序提交、重传/冲突、完成与幂等、内容去重、完整性拒绝。
- `test/crash.test.ts`：子进程在提交/完成返回前后被 SIGKILL，重开后验证进度不倒退、引用稳定、字节一致、磁盘占用回收。
- `test/edge.test.ts`：零字节文件、整段边界、完成后重复开始。

崩溃注入通过环境变量 `UPLOAD_STORE_CRASH_AT`（如 `submitChunk:afterDbInsert@2`）在库内部精确触发，仅供测试使用。
