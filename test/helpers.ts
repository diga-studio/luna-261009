import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHUNK_SIZE } from "../src/index";

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upload-store-test-"));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface FakeFile {
  chunks: Buffer[];
  whole: Buffer;
  totalBytes: number;
  sha256: string;
}

/** 生成确定性的伪随机文件内容（按 5 MiB 分段）。 */
export function makeFakeFile(totalBytes: number, seed = 1): FakeFile {
  const chunks: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < totalBytes) {
    const size = Math.min(CHUNK_SIZE, totalBytes - offset);
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) {
      buf[i] = (seed * 31 + index * 7 + i) % 251;
    }
    chunks.push(buf);
    offset += size;
    index += 1;
  }
  const whole = Buffer.concat(chunks);
  return { chunks, whole, totalBytes, sha256: sha256(whole) };
}

/** 递归统计目录下文件数量与总字节数。 */
export function dirUsage(dir: string): { files: number; bytes: number } {
  if (!fs.existsSync(dir)) {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirUsage(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}
