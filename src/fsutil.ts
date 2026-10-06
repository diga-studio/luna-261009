import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 写入临时文件并 fsync 后原子改名到目标路径，再 fsync 所在目录。 */
export function writeFileAtomic(tmpPath: string, finalPath: string, data: Buffer): void {
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
  fsyncDir(path.dirname(finalPath));
}

export function sha256Buffer(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const IO_BUFFER_SIZE = 1024 * 1024;

/** 按顺序把多个文件拼接到目标临时文件，fsync 后由调用方负责改名。 */
export function concatFiles(sourcePaths: string[], destTmpPath: string): void {
  const out = fs.openSync(destTmpPath, "w");
  const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
  try {
    for (const sourcePath of sourcePaths) {
      const input = fs.openSync(sourcePath, "r");
      try {
        for (;;) {
          const read = fs.readSync(input, buffer, 0, buffer.length, null);
          if (read === 0) {
            break;
          }
          let offset = 0;
          while (offset < read) {
            offset += fs.writeSync(out, buffer, offset, read - offset);
          }
        }
      } finally {
        fs.closeSync(input);
      }
    }
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(IO_BUFFER_SIZE);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** 递归删除目录（不存在时忽略）。 */
export function removeDirQuiet(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function removeFileQuiet(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
