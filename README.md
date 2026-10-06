# resumable-file-store

大文件校验续传库（TypeScript），由上层直接调用。使用本地文件系统持久化，
重新打开后仍能查询准确的续传进度，并在全部分块确认后流式读取完成文件。

## 特性

- **清单驱动**：上层提供可信且不可变的清单（文件总长度 + 各分块预期 SHA-256）。
  分块固定 64MiB，最后一块可不足 64MiB；清单决定分块顺序与各块长度。
- **乱序 / 重复提交**：分块可以乱序到达、重复提交；只有长度与 SHA-256 均符合
  清单才确认。正确重复只计入一次，尾块按实际长度计数。
- **失败安全**：错误内容、提前结束、接收中途失败均不增加进度，也不损坏同一
  位置此前已确认的数据（先写临时文件，验收通过后原子落位）。
- **断点续传**：已确认进度持久化在本地（`state.json` + 分块文件），重新打开后
  与磁盘对账，进度准确。
- **完整校验读取**：只有全部分块确认后才能读取完成文件，按清单顺序流式输出。

## 安装与测试

```sh
npm install
npm test
```

## 使用

```ts
import { ResumableStore } from "resumable-file-store";

const store = new ResumableStore({ dir: "./upload-data" }); // 分块默认 64MiB

// 1. 登记清单（幂等；同一 fileId 清单冲突会抛错）
await store.registerFile({
  fileId: "video-123",
  totalSize: 150 * 1024 * 1024,
  chunkHashes: [/* 各分块 sha256 hex，按顺序 */],
});

// 2. 接收分块（乱序/重复均可；source 支持 Uint8Array、Readable、AsyncIterable）
const result = await store.receiveChunk("video-123", 3, stream);
// => { accepted: true, duplicate: false } 或 { accepted: false, reason: "..." }

// 3. 查询续传状态
const status = await store.getStatus("video-123");
// => { confirmedChunks, confirmedBytes, missingChunks, complete, ... }

// 4. 全部确认后流式读取完成文件
if (status.complete) {
  for await (const bytes of store.readFile("video-123")) {
    // 按清单顺序输出，逐字节等于原文件
  }
}
```

## 存储结构

```
<dir>/<fileId>/
  manifest.json          # 登记的清单（冲突检测）
  state.json             # 已确认分块下标（原子写）
  chunks/<index>.part    # 已确认分块数据
```

接收中的分块先写入 `chunks/.staging-*` 临时文件，验收（长度 + SHA-256）通过
后原子 rename 落位；失败时临时文件被清理，已确认数据不受影响。
