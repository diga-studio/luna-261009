/** 单个分块的清单条目。size 省略时按 64MiB 计（最后一块按剩余长度）。 */
export interface ManifestChunk {
  sha256: string;
  size?: number;
}

/** 上层提供的可信且不可变的文件清单。 */
export interface FileManifest {
  fileId: string;
  totalSize: number;
  chunks: ManifestChunk[];
  /** 分块大小，默认 64MiB；最后一块可以不足。 */
  chunkSize?: number;
}

/** 展开后的分块描述：顺序、偏移与长度均由清单决定。 */
export interface ChunkPlanEntry {
  index: number;
  offset: number;
  size: number;
  sha256: string;
}

export interface ChunkPlan {
  fileId: string;
  totalSize: number;
  chunkSize: number;
  entries: ChunkPlanEntry[];
}

export interface ResumeStatus {
  fileId: string;
  totalSize: number;
  totalChunks: number;
  confirmedChunks: number;
  confirmedBytes: number;
  /** 仍需提交的分块下标，升序。 */
  missingChunks: number[];
  complete: boolean;
}

export const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024;
