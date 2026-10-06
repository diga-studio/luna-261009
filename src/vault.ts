import { randomBytes } from "node:crypto";
import { decrypt, encrypt, generateKey } from "./crypto";
import { Storage } from "./storage";
import type { RotationProgress } from "./types";

/**
 * 同意凭证库：保存/读取凭证，并按调用方要求分次推进密钥轮换。
 *
 * 持久化布局（全部位于构造参数 dir 之下）：
 * - keyring.json       密钥表与当前密钥编号
 * - rotation.json      轮换状态（进行中的轮换与已完成业务编号）
 * - credentials/*.json 逐条凭证的密文、nonce、认证标签与所用密钥编号
 *
 * 个人信息明文只存在于内存中，任何持久化文件只保存密文。
 */
export class ConsentVault {
  private readonly storage: Storage;

  constructor(dir: string) {
    this.storage = new Storage(dir);
    const keyring = this.storage.loadKeyring();
    if (keyring.currentKeyId === "") {
      const keyId = this.newKeyId();
      keyring.keys[keyId] = generateKey();
      keyring.currentKeyId = keyId;
      this.storage.saveKeyring(keyring);
    }
  }

  /** 保存凭证；保存后内容不可修改（同编号重复保存将抛错）。 */
  saveCredential(id: string, pii: Buffer): void {
    if (this.storage.hasCredential(id)) {
      throw new Error(`credential already exists: ${id}`);
    }
    const keyring = this.storage.loadKeyring();
    const keyId = keyring.currentKeyId;
    const { nonce, tag, data } = encrypt(keyring.keys[keyId], pii);
    this.storage.saveCredential(id, { keyId, nonce, tag, data });
  }

  /** 读取凭证，返回与保存时逐字节一致的明文；不存在返回 null。 */
  readCredential(id: string): Buffer | null {
    const record = this.storage.loadCredential(id);
    if (record === null) {
      return null;
    }
    const keyring = this.storage.loadKeyring();
    const key = keyring.keys[record.keyId];
    if (key === undefined) {
      throw new Error(`missing key ${record.keyId} for credential ${id}`);
    }
    return decrypt(key, record.nonce, record.tag, record.data);
  }

  /**
   * 推进业务编号为 rotationId 的轮换，每次最多转换 batchSize 条凭证。
   *
   * - 相同编号重复调用继续同一轮；
   * - 已完成编号再次调用直接报告完成，不改变任何状态；
   * - 首次推进即启用全新密钥，此后保存的凭证均使用新密钥；
   * - 仅当不再有任何凭证依赖旧密钥、且旧密钥已从密钥表中移除时，
   *   才报告完成。
   */
  advanceRotation(rotationId: string, batchSize = 100): RotationProgress {
    if (batchSize < 1) {
      throw new Error("batchSize must be >= 1");
    }
    const state = this.storage.loadRotationState();
    if (state.completed.includes(rotationId)) {
      return { done: true, converted: 0, remaining: 0 };
    }
    if (state.active !== null && state.active.rotationId !== rotationId) {
      throw new Error(
        `rotation ${state.active.rotationId} is still in progress`,
      );
    }

    const keyring = this.storage.loadKeyring();
    if (state.active === null) {
      const oldKeyId = keyring.currentKeyId;
      const newKeyId = this.newKeyId();
      keyring.keys[newKeyId] = generateKey();
      keyring.currentKeyId = newKeyId;
      this.storage.saveKeyring(keyring);
      state.active = { rotationId, oldKeyId, newKeyId };
      this.storage.saveRotationState(state);
    }
    const { oldKeyId, newKeyId } = state.active;
    const oldKey = keyring.keys[oldKeyId];
    const newKey = keyring.keys[newKeyId];
    if (oldKey === undefined || newKey === undefined) {
      throw new Error("rotation state references a missing key");
    }

    let converted = 0;
    let remaining = 0;
    for (const id of this.storage.listCredentialIds()) {
      const record = this.storage.loadCredential(id);
      if (record === null || record.keyId !== oldKeyId) {
        continue;
      }
      if (converted < batchSize) {
        const plaintext = decrypt(oldKey, record.nonce, record.tag, record.data);
        const fresh = encrypt(newKey, plaintext);
        this.storage.saveCredential(id, { keyId: newKeyId, ...fresh });
        converted += 1;
      } else {
        remaining += 1;
      }
    }

    if (remaining > 0) {
      return { done: false, converted, remaining };
    }

    delete keyring.keys[oldKeyId];
    this.storage.saveKeyring(keyring);
    state.completed.push(rotationId);
    state.active = null;
    this.storage.saveRotationState(state);
    return { done: true, converted, remaining: 0 };
  }

  private newKeyId(): string {
    const keyring = this.storage.loadKeyring();
    let keyId: string;
    do {
      keyId = randomBytes(16).toString("hex");
    } while (keyId in keyring.keys);
    return keyId;
  }
}
