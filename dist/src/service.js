"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScreenshotUploadService = exports.UploadError = void 0;
const node_crypto_1 = require("node:crypto");
const fileStore_1 = require("./fileStore");
const store_1 = require("./store");
const types_1 = require("./types");
class UploadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'UploadError';
    }
}
exports.UploadError = UploadError;
function sha256Hex(bytes) {
    return (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
}
function attachmentIdFor(sha256) {
    return `att_${sha256}`;
}
function expectedChunkCount(byteLength) {
    return byteLength === 0 ? 0 : Math.ceil(byteLength / types_1.CHUNK_SIZE);
}
function expectedChunkLength(byteLength, chunkIndex) {
    const count = expectedChunkCount(byteLength);
    if (chunkIndex === count - 1) {
        const rest = byteLength % types_1.CHUNK_SIZE;
        return rest === 0 ? types_1.CHUNK_SIZE : rest;
    }
    return types_1.CHUNK_SIZE;
}
function normalizeDecl(files) {
    return JSON.stringify(files.map((f) => ({ byteLength: f.byteLength, sha256: f.sha256 })));
}
/**
 * CrashLens screenshot resumable-upload component.
 * Single-process, serial calls only.
 */
class ScreenshotUploadService {
    store;
    files;
    hooks;
    constructor(storageDir, options = {}) {
        this.files = new fileStore_1.FileStore(storageDir);
        this.store = new store_1.MetadataStore(this.files.rootDir + '/meta.sqlite');
        this.hooks = options.hooks ?? {};
        this.recover();
    }
    /**
     * Reopen recovery: drop artifacts of terminal batches, orphan chunk files,
     * stale staging candidates and unreferenced attachment files. Confirmed
     * chunks of still-open batches are preserved.
     */
    recover() {
        const validChunkPaths = new Set();
        for (const key of this.store.listOpenBatchKeys()) {
            for (const c of this.store.listChunks(key)) {
                validChunkPaths.add(this.files.chunkPath(key, c.fileIndex, c.chunkIndex));
            }
        }
        const referenced = new Set(this.store.listAllAttachmentPaths());
        this.files.sweep(this.store.listTerminalBatchKeys(), validChunkPaths, referenced);
    }
    begin(uploadKey, ticketId, files) {
        this.validateDecl(files);
        const existing = this.store.getBatch(uploadKey);
        if (existing) {
            if (existing.ticketId !== ticketId || normalizeDecl(existing.files) !== normalizeDecl(files)) {
                throw new UploadError('DECLARATION_MISMATCH', `uploadKey ${uploadKey} already exists with a different declaration`);
            }
            return { uploadKey, ticketId, state: existing.state, reused: true };
        }
        this.store.createBatch(uploadKey, ticketId, files);
        return { uploadKey, ticketId, state: 'open', reused: false };
    }
    putChunk(uploadKey, fileIndex, chunkIndex, bytes) {
        const batch = this.store.getBatch(uploadKey);
        if (!batch)
            throw new UploadError('BATCH_NOT_FOUND', `unknown uploadKey ${uploadKey}`);
        if (batch.state !== 'open') {
            throw new UploadError('BATCH_CLOSED', `batch ${uploadKey} is ${batch.state}`);
        }
        const decl = batch.files[fileIndex];
        if (!decl) {
            throw new UploadError('INVALID_ARGUMENT', `fileIndex ${fileIndex} out of range`);
        }
        const count = expectedChunkCount(decl.byteLength);
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= count) {
            throw new UploadError('INVALID_ARGUMENT', `chunkIndex ${chunkIndex} out of range (0..${count - 1})`);
        }
        if (bytes.length !== expectedChunkLength(decl.byteLength, chunkIndex)) {
            throw new UploadError('INVALID_ARGUMENT', `chunk ${chunkIndex} of file ${fileIndex} must be ${expectedChunkLength(decl.byteLength, chunkIndex)} bytes, got ${bytes.length}`);
        }
        const digest = sha256Hex(bytes);
        const existing = this.store.getChunk(uploadKey, fileIndex, chunkIndex);
        if (existing) {
            if (existing.sha256 === digest && existing.byteLength === bytes.length) {
                return; // identical retry: no-op
            }
            throw new UploadError('CHUNK_CONFLICT', `chunk ${chunkIndex} of file ${fileIndex} already accepted with different bytes`);
        }
        const chunk = { fileIndex, chunkIndex, byteLength: bytes.length, sha256: digest };
        // Persist bytes first, then metadata. A crash in between leaves an orphan
        // file that recovery sweeps; Inspect never claims it as accepted.
        this.files.writeChunk(uploadKey, chunk, bytes);
        this.store.addChunk(uploadKey, chunk);
    }
    commit(uploadKey) {
        const batch = this.store.getBatch(uploadKey);
        if (!batch)
            throw new UploadError('BATCH_NOT_FOUND', `unknown uploadKey ${uploadKey}`);
        if (batch.state === 'committed') {
            return { status: 'committed', attachments: batch.commitResult };
        }
        if (batch.state === 'failed') {
            return { status: 'failed', reason: batch.failureReason };
        }
        // Check completeness against accepted chunk metadata.
        const accepted = new Set(this.store.listChunks(uploadKey).map((c) => `${c.fileIndex}:${c.chunkIndex}`));
        const missing = [];
        batch.files.forEach((decl, fileIndex) => {
            const count = expectedChunkCount(decl.byteLength);
            for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
                if (!accepted.has(`${fileIndex}:${chunkIndex}`)) {
                    missing.push({
                        fileIndex,
                        chunkIndex,
                        byteLength: expectedChunkLength(decl.byteLength, chunkIndex),
                        sha256: '',
                    });
                }
            }
        });
        if (missing.length > 0)
            return { status: 'incomplete', missing };
        // Assemble and verify every file before publishing anything.
        const staged = [];
        for (let fileIndex = 0; fileIndex < batch.files.length; fileIndex++) {
            const decl = batch.files[fileIndex];
            const chunkPaths = [];
            for (let chunkIndex = 0; chunkIndex < expectedChunkCount(decl.byteLength); chunkIndex++) {
                chunkPaths.push(this.files.chunkPath(uploadKey, fileIndex, chunkIndex));
            }
            const stagingPath = this.files.stagingPath(uploadKey, fileIndex);
            const actualSha256 = this.files.assembleFile(chunkPaths, stagingPath);
            staged.push({ fileIndex, stagingPath, actualSha256 });
        }
        this.hooks.afterStaging?.();
        for (const s of staged) {
            const declared = batch.files[s.fileIndex].sha256;
            if (s.actualSha256 !== declared) {
                const reason = `sha256 mismatch on file ${s.fileIndex}: declared ${declared}, actual ${s.actualSha256}`;
                this.store.recordFailure(uploadKey, reason);
                this.cleanupBatch(uploadKey);
                this.hooks.afterCommitRecord?.();
                return { status: 'failed', reason };
            }
        }
        // Publish: move every verified candidate into its final, content-addressed
        // location. Attachment identity is deterministic per (ticketId, sha256),
        // so republishing after a crash converges to the same files and ids.
        const rows = [];
        const result = [];
        for (const s of staged) {
            const sha256 = batch.files[s.fileIndex].sha256;
            const attachmentId = attachmentIdFor(sha256);
            const finalPath = this.files.attachmentPath(batch.ticketId, attachmentId);
            this.files.publishFile(s.stagingPath, finalPath);
            rows.push({ ticketId: batch.ticketId, sha256, attachmentId, path: finalPath });
            result.push({ attachmentId, path: finalPath });
        }
        this.hooks.beforeCommitRecord?.();
        this.store.recordCommit(uploadKey, rows, result);
        this.cleanupBatch(uploadKey);
        this.hooks.afterCommitRecord?.();
        return { status: 'committed', attachments: result };
    }
    inspect(uploadKey) {
        const batch = this.store.getBatch(uploadKey);
        if (!batch)
            throw new UploadError('BATCH_NOT_FOUND', `unknown uploadKey ${uploadKey}`);
        const result = {
            uploadKey,
            ticketId: batch.ticketId,
            state: batch.state,
            acceptedChunks: this.store.listChunks(uploadKey),
            ticketAttachments: this.store
                .listAttachmentsForTicket(batch.ticketId)
                .map((a) => ({ attachmentId: a.attachmentId, path: a.path })),
        };
        if (batch.state === 'committed' && batch.commitResult) {
            result.commitResult = batch.commitResult;
        }
        if (batch.state === 'failed' && batch.failureReason) {
            result.failureReason = batch.failureReason;
        }
        return result;
    }
    cleanupBatch(uploadKey) {
        try {
            this.files.removeBatchArtifacts(uploadKey);
        }
        catch {
            // Leftovers are swept on the next reopen; never fail a terminal commit.
        }
    }
    validateDecl(files) {
        if (!Array.isArray(files) || files.length < 1 || files.length > 5) {
            throw new UploadError('INVALID_DECLARATION', 'a batch must declare 1 to 5 files');
        }
        for (const f of files) {
            if (!Number.isInteger(f.byteLength) || f.byteLength < 0) {
                throw new UploadError('INVALID_DECLARATION', `invalid byteLength ${f.byteLength}`);
            }
            if (!/^[0-9a-f]{64}$/.test(f.sha256)) {
                throw new UploadError('INVALID_DECLARATION', `invalid sha256 ${f.sha256}`);
            }
        }
    }
    close() {
        this.store.close();
    }
}
exports.ScreenshotUploadService = ScreenshotUploadService;
