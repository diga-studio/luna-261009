/** 一张待上传截图的声明信息。 */
export interface DeclaredFile {
  /** 声明的字节数。 */
  size: number;
  /** 声明的 SHA-256（小写十六进制，64 字符）。 */
  sha256: string;
}

/** 批次状态。 */
export type BatchStatus = "uploading" | "committed" | "failed";

/** 已发布附件的标识与本地路径。 */
export interface AttachmentRef {
  attachmentId: string;
  path: string;
}

/** Commit 的终结结果。 */
export type CommitResult =
  | { status: "committed"; attachments: AttachmentRef[] }
  | { status: "failed"; reason: string };

/** Commit 时发现缺块：批次保持可续传，不进入终结态。 */
export interface IncompleteResult {
  status: "incomplete";
  missing: Array<{ fileIndex: number; chunkIndex: number }>;
}

export type CommitOutcome = CommitResult | IncompleteResult;

/** Inspect 返回的批次视图。 */
export interface InspectResult {
  /** 批次不存在时为 "unknown"。 */
  status: BatchStatus | "unknown";
  /** 已接受（已持久化确认）的分块坐标，按 fileIndex/chunkIndex 排序。 */
  acceptedChunks: Array<{ fileIndex: number; chunkIndex: number }>;
  /** 该工单当前全部已发布附件（含本批次及其他批次）。 */
  ticketAttachments: AttachmentRef[];
  /** 批次已终结时，返回终结结果（重复 Commit 应得到同一结果）。 */
  terminalResult?: CommitResult;
}

/** 测试专用暂停点：在指定持久化边界调用钩子（子进程可在此自杀以模拟崩溃）。 */
export interface CrashHooks {
  /** PutChunk：分块文件已落盘且元数据已记录之后、返回之前。 */
  afterChunkPersist?: () => void;
  /** Commit：全部候选文件已校验并放入附件区之后、批次发布事务之前。 */
  afterFilePersistBeforePublish?: () => void;
  /** Commit：批次发布事务已提交之后、清理与返回之前。 */
  afterPublishBeforeReturn?: () => void;
}
