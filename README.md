# resumable-upload

大文件校验续传库（TypeScript），由上层直接调用。使用本地文件系统持久化，
进程重启后仍能查询准确的续传进度，并在全部分块确认后流式读出完成文件。

## 特性

- 登记可信且不可变的文件清单（总长度 + 各分块预期 SHA-256）
- 分块默认固定 64MiB，最后一块可不足；清单决定分块顺序与各块长度
- 分块可乱序、可重复到达；只有长度与 SHA-256 都符合清单才确认
- 错误内容、提前结束、接收失败均不增加进度，也不损坏已确认数据
- 状态精确反映已确认进度与缺失分块；正确重复只计一次
- 全部确认后才能读取，读出字节与清单对应的原文件逐字节一致

## 使用

```ts
import { ResumableUpload } from "resumable-upload";

const up = new ResumableUpload("./upload-data");

// 1. 登记清单（同一 fileId 重复登记内容必须一致，幂等）
await up.registerManifest({
  fileId: "video-123",
  totalSize: 150 * 1024 * 1024,
  chunks: [
    { sha256: "…第0块64MiB的SHA-256…" },
    { sha256: "…第1块64MiB的SHA-256…" },
    { sha256: "…尾块实际长度的SHA-256…" },
  ],
});

// 2. 接收分块（乱序/重复均可，stream 为任意 AsyncIterable<Uint8Array>）
const result = await up.receiveChunk("video-123", 1, byteStream);
// { ok: true, alreadyConfirmed: false } | { ok: false, reason: "…" }

// 3. 查询续传状态
const status = await up.getStatus("video-123");
// { totalChunks, confirmedChunks, confirmedBytes, missingChunks, complete, … }

// 4. 全部确认后流式读取完成文件
if (status.complete) {
  for await (const bytes of await up.readFile("video-123")) {
    // …
  }
}
```

## 持久化布局

```
<storageDir>/<fileId>/
  manifest.json   登记的清单与展开后的分块计划
  state.json      已确认分块下标（原子写入）
  chunks/<index>  已确认分块数据（临时文件校验通过后原子改名）
  tmp/            接收中的临时文件（失败即清理）
```

重新打开（用同一目录新建实例）后，状态由 `state.json` 与磁盘上的分块文件
对账得出：只有状态记录且数据完整的分块才计入进度。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js（>=18）与 `npm install` 安装的 devDependencies（typescript、
@types/node），不依赖任何本机服务或全局工具。
