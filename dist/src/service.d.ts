import { BeginResult, CommitResult, FileDecl, InspectResult } from './types';
export type UploadErrorCode = 'BATCH_NOT_FOUND' | 'DECLARATION_MISMATCH' | 'BATCH_CLOSED' | 'CHUNK_CONFLICT' | 'INVALID_DECLARATION' | 'INVALID_ARGUMENT';
export declare class UploadError extends Error {
    readonly code: UploadErrorCode;
    constructor(code: UploadErrorCode, message: string);
}
/** Test-only pause points invoked at persistence boundaries. */
export interface CommitHooks {
    /** After all candidate files are durably staged, before publishing. */
    afterStaging?: () => void;
    /** After final files are in place, before the commit is recorded. */
    beforeCommitRecord?: () => void;
    /** After the commit/failure is recorded, before Commit returns. */
    afterCommitRecord?: () => void;
}
export interface ServiceOptions {
    hooks?: CommitHooks;
}
/**
 * CrashLens screenshot resumable-upload component.
 * Single-process, serial calls only.
 */
export declare class ScreenshotUploadService {
    private store;
    private files;
    private hooks;
    constructor(storageDir: string, options?: ServiceOptions);
    /**
     * Reopen recovery: drop artifacts of terminal batches, orphan chunk files,
     * stale staging candidates and unreferenced attachment files. Confirmed
     * chunks of still-open batches are preserved.
     */
    private recover;
    begin(uploadKey: string, ticketId: string, files: FileDecl[]): BeginResult;
    putChunk(uploadKey: string, fileIndex: number, chunkIndex: number, bytes: Uint8Array): void;
    commit(uploadKey: string): CommitResult;
    inspect(uploadKey: string): InspectResult;
    private cleanupBatch;
    private validateDecl;
    close(): void;
}
