# task26100920

NimbusSync 上传流水线：流式 JPEG 去 EXIF 组件（输出用于后续内容去重）。

## API

```ts
import { sanitizeJpeg } from './src/sanitizeJpeg';

const sha256: string = await sanitizeJpeg(chunks, destination);
```

- `chunks`: `AsyncIterable<Uint8Array>`，调用方已顺序重组的上传块，块边界可落在任意字节之间。
- `destination`: 净化结果写入的本地文件路径。
- 返回值：净化后字节流的 SHA-256（hex），而非上传原文的哈希。

行为：仅删除真实 APP1 段中载荷以 `45 78 69 66 00 00`（`Exif\0\0`）开头的段（整段删除，EXIF 内部 TIFF 损坏不影响）；XMP 等其他 APP1、其他所有段、熵编码数据中的相同字节序列、标记前的连续 FF 填充字节全部原样保留。支持多 SOS 扫描、扫描间普通段、转义 `FF 00`、RST0–RST7、TEM、DNL。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 先编译 TypeScript 再运行 `node:test` 测试。
