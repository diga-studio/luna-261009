/** 固定分段大小：5 MiB */
export const CHUNK_SIZE = 5 * 1024 * 1024;

/** 会话进度快照 */
export interface Progress {
  sessionId: string;
  totalBytes: number;
  sha256: string;
  /** 已确认分段序号（升序） */
  confirmedChunks: number[];
  completed: boolean;
  /** 完成后可直接读取的本地文件路径 */
  filePath?: string;
}

/** 完成上传后的文件引用 */
export interface FileRef {
  path: string;
  sha256: string;
  size: number;
}

export class UploadError extends Error {}

/** 会话不存在或会话声明与已有声明冲突 */
export class SessionError extends UploadError {}

/** 分段序号、长度或内容不合法（含同序号重传不同字节） */
export class ChunkError extends UploadError {}

/** 完整性校验失败，无法完成 */
export class IntegrityError extends UploadError {}
