/** 钥匙串文件的持久化结构。 */
export interface KeyringFile {
  /** 当前用于加密新凭证的密钥编号。 */
  currentKeyId: string;
  /** keyId -> base64 编码的 256 位密钥。 */
  keys: Record<string, string>;
}

/** 单条凭证文件的持久化结构（不含明文）。 */
export interface CredentialFile {
  /** 加密该凭证所用的密钥编号。 */
  keyId: string;
  /** base64 编码的随机 nonce。 */
  nonce: string;
  /** base64 编码的认证标签。 */
  tag: string;
  /** base64 编码的密文。 */
  data: string;
}

/** 轮换状态文件的持久化结构。 */
export interface RotationStateFile {
  /** 正在进行中的轮换；无则为 null。 */
  active: ActiveRotation | null;
  /** 已完成的轮换业务编号。 */
  completed: string[];
}

export interface ActiveRotation {
  /** 调用方提供的唯一业务编号。 */
  rotationId: string;
  /** 待淘汰的旧密钥编号。 */
  oldKeyId: string;
  /** 本轮启用的新密钥编号。 */
  newKeyId: string;
}

/** 每次推进轮换的返回结果。 */
export interface RotationProgress {
  /** 该业务编号对应的轮换是否已完成。 */
  done: boolean;
  /** 本次调用转换的凭证数量。 */
  converted: number;
  /** 仍依赖旧密钥的凭证数量（完成后为 0）。 */
  remaining: number;
}
