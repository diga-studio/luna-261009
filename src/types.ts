/** 持久化的密钥记录（keyMaterial 为 base64 编码的 256 位密钥）。 */
export interface KeyRecord {
  keyId: string;
  keyMaterial: string;
  createdAt: string;
}

/** 密钥环文件的磁盘格式。 */
export interface KeyringFile {
  /** 当前用于加密新凭证的密钥。 */
  activeKeyId: string;
  keys: KeyRecord[];
}

/** 单条凭证的磁盘格式：个人信息只以密文形式出现。 */
export interface CredentialFile {
  credentialId: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** 轮换状态文件的磁盘格式。 */
export interface RotationStateFile {
  /** 进行中的轮换；同一时刻至多一个。 */
  inProgress: { rotationId: string; newKeyId: string } | null;
  /** 已完成的轮换业务编号。 */
  completed: string[];
}

/** 一次推进轮换的返回值。 */
export interface RotationProgress {
  /** 该轮换是否已完成。 */
  done: boolean;
  /** 本次推进重新加密的凭证条数。 */
  reencrypted: number;
  /** 仍依赖旧密钥的凭证条数。 */
  remaining: number;
}
