import * as fs from "node:fs";
import * as path from "node:path";
import { CredentialFile } from "./types";

/** 凭证文件的读写与列举；每条凭证一个文件。 */
export class CredentialStore {
  constructor(private readonly dirPath: string) {}

  private filePath(credentialId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(credentialId)) {
      throw new Error(`invalid credential id: ${credentialId}`);
    }
    return path.join(this.dirPath, `${credentialId}.json`);
  }

  /** 写入凭证文件（原子写）；同编号已存在时拒绝覆盖。 */
  write(record: CredentialFile): void {
    fs.mkdirSync(this.dirPath, { recursive: true });
    const target = this.filePath(record.credentialId);
    if (fs.existsSync(target)) {
      throw new Error(`credential already exists: ${record.credentialId}`);
    }
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  /** 覆盖已有凭证文件（仅轮换重加密时使用）。 */
  overwrite(record: CredentialFile): void {
    const target = this.filePath(record.credentialId);
    if (!fs.existsSync(target)) {
      throw new Error(`credential not found: ${record.credentialId}`);
    }
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  read(credentialId: string): CredentialFile {
    const target = this.filePath(credentialId);
    if (!fs.existsSync(target)) {
      throw new Error(`credential not found: ${credentialId}`);
    }
    return JSON.parse(fs.readFileSync(target, "utf8")) as CredentialFile;
  }

  /** 按编号排序列出全部凭证，保证轮换推进顺序稳定。 */
  list(): CredentialFile[] {
    if (!fs.existsSync(this.dirPath)) {
      return [];
    }
    return fs
      .readdirSync(this.dirPath)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.dirPath, name), "utf8")) as CredentialFile);
  }
}
