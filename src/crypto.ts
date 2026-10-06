import * as crypto from "node:crypto";

export interface SealedBox {
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** 使用 256 位密钥做 AES-256-GCM 认证加密。 */
export function seal(keyMaterial: Buffer, plaintext: Uint8Array): SealedBox {
  if (keyMaterial.length !== 32) {
    throw new Error(`key must be 32 bytes, got ${keyMaterial.length}`);
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** 解密并校验认证标签；标签不匹配时抛错。 */
export function open(keyMaterial: Buffer, box: SealedBox): Buffer {
  if (keyMaterial.length !== 32) {
    throw new Error(`key must be 32 bytes, got ${keyMaterial.length}`);
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    keyMaterial,
    Buffer.from(box.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ciphertext, "base64")),
    decipher.final(),
  ]);
}
