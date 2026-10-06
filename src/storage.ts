import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CredentialFile, KeyringFile, RotationStateFile } from "./types";

const KEYRING_FILE = "keyring.json";
const ROTATION_FILE = "rotation.json";
const CREDENTIALS_DIR = "credentials";
const CREDENTIAL_SUFFIX = ".json";

/** 凭证编号只允许安全字符，避免路径穿越。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 基于本地文件系统的持久化层；所有写入先落临时文件再原子改名。 */
export class Storage {
  private readonly dir: string;
  private readonly credentialsDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.credentialsDir = join(dir, CREDENTIALS_DIR);
    mkdirSync(this.credentialsDir, { recursive: true });
  }

  loadKeyring(): KeyringFile {
    const file = join(this.dir, KEYRING_FILE);
    if (!existsSync(file)) {
      return { currentKeyId: "", keys: {} };
    }
    return JSON.parse(readFileSync(file, "utf8")) as KeyringFile;
  }

  saveKeyring(keyring: KeyringFile): void {
    this.writeJsonAtomic(join(this.dir, KEYRING_FILE), keyring);
  }

  loadRotationState(): RotationStateFile {
    const file = join(this.dir, ROTATION_FILE);
    if (!existsSync(file)) {
      return { active: null, completed: [] };
    }
    return JSON.parse(readFileSync(file, "utf8")) as RotationStateFile;
  }

  saveRotationState(state: RotationStateFile): void {
    this.writeJsonAtomic(join(this.dir, ROTATION_FILE), state);
  }

  saveCredential(id: string, record: CredentialFile): void {
    this.writeJsonAtomic(this.credentialPath(id), record);
  }

  loadCredential(id: string): CredentialFile | null {
    const file = this.credentialPath(id);
    if (!existsSync(file)) {
      return null;
    }
    return JSON.parse(readFileSync(file, "utf8")) as CredentialFile;
  }

  hasCredential(id: string): boolean {
    return existsSync(this.credentialPath(id));
  }

  listCredentialIds(): string[] {
    return readdirSync(this.credentialsDir)
      .filter((name) => name.endsWith(CREDENTIAL_SUFFIX))
      .map((name) => name.slice(0, -CREDENTIAL_SUFFIX.length))
      .sort();
  }

  private credentialPath(id: string): string {
    if (!SAFE_ID.test(id)) {
      throw new Error(`invalid credential id: ${JSON.stringify(id)}`);
    }
    return join(this.credentialsDir, id + CREDENTIAL_SUFFIX);
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const tmp = join(
      this.dir,
      `.tmp-${randomBytes(8).toString("hex")}`,
    );
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  }
}
