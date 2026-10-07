import { ChunkRef } from './types';
/**
 * Filesystem layout under the storage directory:
 *   meta.sqlite                 metadata database
 *   chunks/<key>/<f>/<c>.part   confirmed chunk payloads of open batches
 *   staging/<key>/<f>.bin       assembled candidate files during commit
 *   attachments/<ticket>/<id>   published final files
 */
export declare class FileStore {
    readonly rootDir: string;
    constructor(rootDir: string);
    chunkPath(uploadKey: string, fileIndex: number, chunkIndex: number): string;
    stagingPath(uploadKey: string, fileIndex: number): string;
    attachmentPath(ticketId: string, attachmentId: string): string;
    /** Durably write a chunk payload (temp file + fsync + rename). */
    writeChunk(uploadKey: string, chunk: ChunkRef, bytes: Uint8Array): void;
    readChunk(uploadKey: string, fileIndex: number, chunkIndex: number): Uint8Array;
    /**
     * Assemble chunk files in order into `destPath` (atomic write),
     * returning the hex SHA-256 of the assembled bytes.
     */
    assembleFile(chunkPaths: string[], destPath: string): string;
    /**
     * Durably move a staged candidate into its final attachment location.
     * If the final file already exists (same content-addressed identity),
     * the staged copy is simply discarded.
     */
    publishFile(stagingPath: string, finalPath: string): void;
    exists(p: string): boolean;
    removeBatchArtifacts(uploadKey: string): void;
    /**
     * Delete unreferenced files left behind by interrupted operations:
     * - chunk/staging dirs of terminal batches
     * - all staging dirs (candidates are rebuilt on retry)
     * - chunk files of open batches that have no metadata row
     * - attachment files with no metadata row
     * Chunks of still-resumable batches that are confirmed in metadata are kept.
     */
    sweep(terminalBatchKeys: string[], validChunkPaths: Set<string>, referencedAttachmentPaths: Set<string>): void;
}
