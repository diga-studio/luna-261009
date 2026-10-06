/** Stable identifier chosen by the caller for an upload session. */
export type SessionId = string;

/** Declaration made when a session is started. Immutable afterwards. */
export interface SessionDeclaration {
  sessionId: SessionId;
  /** Total size of the whole file in bytes. */
  totalSize: number;
  /** Hex-encoded SHA-256 of the whole file. */
  sha256: string;
}

export interface ConfirmedChunk {
  /** Zero-based chunk index. */
  index: number;
  /** Byte length of this chunk. */
  size: number;
  /** Hex-encoded SHA-256 of the chunk bytes. */
  sha256: string;
}

export interface SessionProgress {
  sessionId: SessionId;
  totalSize: number;
  sha256: string;
  /** Total number of chunks implied by totalSize. */
  chunkCount: number;
  /** All confirmed chunks, ascending by index. */
  confirmedChunks: ConfirmedChunk[];
  /** Whether the session has completed. */
  completed: boolean;
  /** Local file reference of the complete file, present only when completed. */
  fileRef?: string;
}

export interface CompleteResult {
  /** Absolute path of the readable complete file. */
  fileRef: string;
  /** Hex-encoded SHA-256 of the complete file (equals the declared one). */
  sha256: string;
  size: number;
}

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}
