# resumable-upload-store

可恢复的分段上传库（TypeScript）。由上层文件平台直接调用：文件内容与临时分段放在本地目录，会话进度与完成结果存 SQLite（Node 内置 `node:sqlite`，无原生依赖）。

## 环境要求

- Node.js >= 23.4（`node:sqlite` 自该版本起无需标志位）
- 仅依赖 `devDependencies` 中的 `typescript` / `@types/node`：`npm install` 后 `npm test` 即可运行

## API

```ts
import { UploadStore } from "resumable-upload-store";

const store = new UploadStore("/path/to/storage"); // 打开即完成崩溃恢复

store.begin(sessionId, totalBytes, sha256);   // 开始会话（幂等；声明不可改变）
store.submitChunk(sessionId, index, buffer);  // 提交分段（5 MiB 定长，末段可短，允许乱序）
const p = store.progress(sessionId);          // { confirmedChunks, completed, filePath? }
const ref = store.complete(sessionId);        // => { path, sha256, size } 可直接读取
store.close();
```

## 语义保证

- **会话声明不可变**：重复 `begin` 参数一致则幂等（不重置进度），不一致抛 `SessionError`。
- **分段定位**：固定 5 MiB，仅末段可更短，序号从 0 开始，允许乱序提交；每段长度必须与声明总长度对应。
- **同序号重传**：相同字节幂等成功且不增加持久化副本；不同字节抛 `ChunkError` 并保留原数据。该规则在会话完成后依然生效（分段哈希永久保留在 SQLite）。
- **完成条件**：全部分段存在、按序拼接字节数等于声明长度、实际 SHA-256 与声明一致。已存在同校验值的完整文件也不能绕过本会话的完整性检查。未完成的内容不会出现在 `files/` 中。
- **完成引用**：重复完成（含跨重启）返回同一路径；不同会话相同内容共享同一份完整文件（内容寻址）；完整文件只读（`0444`），绝不改写。

## 崩溃恢复

- 持久化顺序：先写文件（fsync + 原子 rename），再提交 SQLite 事务。
- 进程在任意时刻被杀死，重新 `new UploadStore(dir)` 即恢复：
  - 已确认（已返回成功）的操作全部保留，进度不倒退；
  - 被中断未返回的操作表现为"未发生"或"已完成"，查询如实反映；
  - 恢复清除：临时半成品、未确认的分段残留、已完成会话的分段副本、无主完整文件；
  - 恢复本身可再次中断，每步均幂等。
- 同一存储目录假设只有一个进程使用，业务调用串行执行。

## 存储布局

```
<dir>/upload.db          SQLite：sessions（声明/完成状态/文件引用）+ chunks（分段哈希）
<dir>/chunks/<sess>/<n>  已确认分段（会话目录名为 sessionId 的 hex 编码）
<dir>/tmp/<rand>         写入/拼接中的临时文件（恢复时清除）
<dir>/files/<sha256>     完整文件（内容寻址、只读、跨会话去重）
```

## 测试

```sh
npm install
npm test
```

测试覆盖：乱序/重传/冲突、声明不可变、完成后规则、同内容两会话去重、声明校验值存在但实际字节不匹配拒绝完成、空文件；以及通过 SIGKILL 子进程模拟的崩溃恢复——分段提交与完成上传在返回前后被杀、恢复过程被再次中断、恢复后磁盘占用（中间副本已清除）。
