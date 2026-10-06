import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { open, seal } from "./crypto";
import { Keyring } from "./keyring";
import { CredentialStore } from "./store";
import { CredentialFile, KeyringFile, RotationProgress, RotationStateFile } from "./types";

const DEFAULT_BATCH_SIZE = 100;

/** ConsentVault：同意凭证的保存、读取与密钥轮换。 */
export class ConsentVault {
  private readonly keyring: Keyring;
  private readonly store: CredentialStore;
  private readonly rotationStatePath: string;

  /**
   * @param dirPath 持久化目录；密钥、轮换状态与凭证全部保存在该目录下。
   */
  constructor(dirPath: string) {
    this.keyring = new Keyring(path.join(dirPath, "keys.json"));
    this.store = new CredentialStore(path.join(dirPath, "credentials"));
    this.rotationStatePath = path.join(dirPath, "rotation.json");
    this.keyring.loadOrCreate();
  }

  /** 保存凭证，返回唯一编号。保存后内容不可修改。 */
  saveCredential(personalInfo: Uint8Array): string {
    const keyring = this.keyring.loadOrCreate();
    const active = this.requireKey(keyring, keyring.activeKeyId);
    const box = seal(Buffer.from(active.keyMaterial, "base64"), personalInfo);
    const record: CredentialFile = {
      credentialId: `c_${crypto.randomBytes(12).toString("hex")}`,
      keyId: active.keyId,
      ...box,
    };
    this.store.write(record);
    return record.credentialId;
  }

  /** 读取凭证，返回与保存时逐字节一致的内容。 */
  readCredential(credentialId: string): Uint8Array {
    const record = this.store.read(credentialId);
    const keyring = this.keyring.loadOrCreate();
    const key = this.requireKey(keyring, record.keyId);
    return open(Buffer.from(key.keyMaterial, "base64"), record);
  }

  /**
   * 分次推进密钥轮换。
   * - 相同 rotationId 重复调用继续同一轮；
   * - 已完成的 rotationId 再次调用直接报告完成，不改变当前密钥；
   * - 首次推进成功后，新凭证使用本轮新密钥；
   * - 全部凭证不再依赖旧密钥且旧密钥已从磁盘移除后，才报告完成。
   */
  advanceRotation(rotationId: string, batchSize: number = DEFAULT_BATCH_SIZE): RotationProgress {
    if (!rotationId) {
      throw new Error("rotationId must be a non-empty string");
    }
    if (batchSize < 1) {
      throw new Error("batchSize must be >= 1");
    }
    const keyring = this.keyring.loadOrCreate();
    const state = this.loadRotationState();

    if (state.completed.includes(rotationId)) {
      return { done: true, reencrypted: 0, remaining: 0 };
    }

    if (state.inProgress && state.inProgress.rotationId !== rotationId) {
      throw new Error(
        `rotation ${state.inProgress.rotationId} is still in progress; ` +
          `finish it before starting ${rotationId}`,
      );
    }

    if (!state.inProgress) {
      const newKey = this.keyring.generateKey();
      keyring.keys.push(newKey);
      keyring.activeKeyId = newKey.keyId;
      this.keyring.save(keyring);
      state.inProgress = { rotationId, newKeyId: newKey.keyId };
      this.saveRotationState(state);
    }

    const activeKeyId = keyring.activeKeyId;
    const activeKey = this.requireKey(keyring, activeKeyId);
    const activeMaterial = Buffer.from(activeKey.keyMaterial, "base64");

    let reencrypted = 0;
    let remaining = 0;
    for (const record of this.store.list()) {
      if (record.keyId === activeKeyId) {
        continue;
      }
      if (reencrypted < batchSize) {
        const oldKey = this.requireKey(keyring, record.keyId);
        const plaintext = open(Buffer.from(oldKey.keyMaterial, "base64"), record);
        this.store.overwrite({ ...record, keyId: activeKeyId, ...seal(activeMaterial, plaintext) });
        reencrypted += 1;
      } else {
        remaining += 1;
      }
    }

    if (remaining > 0) {
      return { done: false, reencrypted, remaining };
    }

    keyring.keys = keyring.keys.filter((key) => key.keyId === activeKeyId);
    this.keyring.save(keyring);
    state.completed.push(state.inProgress.rotationId);
    state.inProgress = null;
    this.saveRotationState(state);
    return { done: true, reencrypted, remaining: 0 };
  }

  private requireKey(keyring: KeyringFile, keyId: string) {
    const key = keyring.keys.find((candidate) => candidate.keyId === keyId);
    if (!key) {
      throw new Error(`key not found in keyring: ${keyId}`);
    }
    return key;
  }

  private loadRotationState(): RotationStateFile {
    if (!fs.existsSync(this.rotationStatePath)) {
      return { inProgress: null, completed: [] };
    }
    return JSON.parse(fs.readFileSync(this.rotationStatePath, "utf8")) as RotationStateFile;
  }

  private saveRotationState(state: RotationStateFile): void {
    fs.mkdirSync(path.dirname(this.rotationStatePath), { recursive: true });
    const tmp = `${this.rotationStatePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.rotationStatePath);
  }
}
