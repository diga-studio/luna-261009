import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("invalid key: expected 256-bit key");
  }
  return key;
}

/** 生成一个全新的 256 位密钥（base64 编码）。 */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** 用 256 位密钥做 AES-256-GCM 认证加密，返回 nonce/tag/密文（均 base64）。 */
export function encrypt(
  keyBase64: string,
  plaintext: Buffer,
): { nonce: string; tag: string; data: string } {
  const key = decodeKey(keyBase64);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** 认证解密；密钥不符或密文被篡改时抛错。 */
export function decrypt(
  keyBase64: string,
  nonce: string,
  tag: string,
  data: string,
): Buffer {
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
}
