import { BatchState, ChunkRef, FileDecl } from './types';
export interface BatchRow {
    uploadKey: string;
    ticketId: string;
    files: FileDecl[];
    state: BatchState;
    commitResult: {
        attachmentId: string;
        path: string;
    }[] | null;
    failureReason: string | null;
}
export interface AttachmentRow {
    ticketId: string;
    sha256: string;
    attachmentId: string;
    path: string;
}
/** SQLite-backed metadata store. No file bytes are ever stored here. */
export declare class MetadataStore {
    private db;
    constructor(dbPath: string);
    getBatch(uploadKey: string): BatchRow | null;
    createBatch(uploadKey: string, ticketId: string, files: FileDecl[]): void;
    listChunks(uploadKey: string): ChunkRef[];
    getChunk(uploadKey: string, fileIndex: number, chunkIndex: number): ChunkRef | null;
    addChunk(uploadKey: string, chunk: ChunkRef): void;
    /** Atomically record published attachments and mark the batch committed. */
    recordCommit(uploadKey: string, attachments: AttachmentRow[], result: {
        attachmentId: string;
        path: string;
    }[]): void;
    /** Atomically mark the batch failed and drop its chunk metadata. */
    recordFailure(uploadKey: string, reason: string): void;
    listAttachmentsForTicket(ticketId: string): AttachmentRow[];
    listAllAttachmentPaths(): string[];
    /** Upload keys of batches in a terminal state (for chunk/staging sweep). */
    listTerminalBatchKeys(): string[];
    /** Upload keys of batches still resumable. */
    listOpenBatchKeys(): string[];
    close(): void;
}
