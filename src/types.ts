/** 默认分块大小：64 MiB。 */
export const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024;

/** 上层提供的可信且不可变的文件清单。 */
export interface FileManifest {
  /** 文件唯一标识，用于本地存储目录名（需为安全的文件名片段）。 */
  fileId: string;
  /** 文件总长度（字节）。 */
  totalSize: number;
  /** 各分块预期 SHA-256（hex，小写），顺序即分块顺序。 */
  chunkHashes: readonly string[];
}

/** 单个分块在清单中的布局信息。 */
export interface ChunkLayout {
  index: number;
  offset: number;
  size: number;
  sha256: string;
}

/** 续传状态。 */
export interface ResumeStatus {
  fileId: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  /** 已确认（长度与 SHA-256 均验收通过）的分块数。 */
  confirmedChunks: number;
  /** 已确认字节数，最后一块按实际长度计。 */
  confirmedBytes: number;
  /** 仍需提交的分块下标（升序）。 */
  missingChunks: number[];
  complete: boolean;
}

/** receiveChunk 的接收结果。 */
export interface ReceiveResult {
  /** 本次提交是否验收通过（含正确的重复提交）。 */
  accepted: boolean;
  /** 该位置此前是否已确认（正确重复提交时为 true）。 */
  duplicate: boolean;
  /** 失败原因（accepted 为 false 时给出）。 */
  reason?: string;
}

/** 可分块提交的数据来源。 */
export type ChunkSource =
  | AsyncIterable<Uint8Array>
  | NodeJS.ReadableStream
  | Uint8Array;
