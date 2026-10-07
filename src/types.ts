/** Declared metadata for one screenshot in an upload batch. */
export interface FileDecl {
  /** Total byte length of the file. */
  byteLength: number;
  /** Lowercase hex SHA-256 of the whole file. */
  sha256: string;
}

/** Attachment identity returned after a successful commit. */
export interface AttachmentRef {
  attachmentId: string;
  /** Absolute path of the published file on local disk. */
  path: string;
}

export type BatchState = 'open' | 'committed' | 'failed';

export interface BeginResult {
  uploadKey: string;
  ticketId: string;
  state: BatchState;
  /** True when an existing batch with the identical declaration was returned. */
  reused: boolean;
}

export interface ChunkRef {
  fileIndex: number;
  chunkIndex: number;
  byteLength: number;
  sha256: string;
}

export type CommitResult =
  | { status: 'committed'; attachments: AttachmentRef[] }
  | { status: 'incomplete'; missing: ChunkRef[] }
  | { status: 'failed'; reason: string };

export interface InspectResult {
  uploadKey: string;
  ticketId: string;
  state: BatchState;
  /** Chunks confirmed as accepted, in (fileIndex, chunkIndex) order. */
  acceptedChunks: ChunkRef[];
  /** All published attachments for this ticket, in insertion order. */
  ticketAttachments: AttachmentRef[];
  /** Terminal commit result, present once the batch is committed. */
  commitResult?: AttachmentRef[];
  /** Failure reason, present once the batch is failed. */
  failureReason?: string;
}

/** Fixed chunk size: 256 KiB. The last chunk of a file may be shorter. */
export const CHUNK_SIZE = 256 * 1024;
