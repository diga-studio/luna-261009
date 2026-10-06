import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { KeyRecord, KeyringFile } from "./types";

/** 管理密钥环文件：加载、保存、生成新密钥、移除旧密钥。 */
export class Keyring {
  constructor(private readonly filePath: string) {}

  /** 加载密钥环；不存在时生成首个密钥并落盘。 */
  loadOrCreate(): KeyringFile {
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as KeyringFile;
      if (!parsed.activeKeyId || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
        throw new Error(`corrupt keyring file: ${this.filePath}`);
      }
      return parsed;
    }
    const first = this.generateKey();
    const state: KeyringFile = { activeKeyId: first.keyId, keys: [first] };
    this.save(state);
    return state;
  }

  /** 原子写密钥环文件。 */
  save(state: KeyringFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** 生成一个全新的 256 位密钥记录（不落盘）。 */
  generateKey(): KeyRecord {
    return {
      keyId: `k_${crypto.randomBytes(16).toString("hex")}`,
      keyMaterial: crypto.randomBytes(32).toString("base64"),
      createdAt: new Date().toISOString(),
    };
  }
}
