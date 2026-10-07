"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileStore = void 0;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
function seg(s) {
    return encodeURIComponent(s);
}
function fsyncDir(dir) {
    const fd = fs.openSync(dir, 'r');
    try {
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
/** Write bytes to `finalPath` via a temp file + fsync + atomic rename. */
function writeFileAtomic(finalPath, bytes) {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, finalPath);
    fsyncDir(path.dirname(finalPath));
}
/**
 * Filesystem layout under the storage directory:
 *   meta.sqlite                 metadata database
 *   chunks/<key>/<f>/<c>.part   confirmed chunk payloads of open batches
 *   staging/<key>/<f>.bin       assembled candidate files during commit
 *   attachments/<ticket>/<id>   published final files
 */
class FileStore {
    rootDir;
    constructor(rootDir) {
        this.rootDir = path.resolve(rootDir);
        for (const d of ['chunks', 'staging', 'attachments']) {
            fs.mkdirSync(path.join(this.rootDir, d), { recursive: true });
        }
    }
    chunkPath(uploadKey, fileIndex, chunkIndex) {
        return path.join(this.rootDir, 'chunks', seg(uploadKey), String(fileIndex), `${chunkIndex}.part`);
    }
    stagingPath(uploadKey, fileIndex) {
        return path.join(this.rootDir, 'staging', seg(uploadKey), `${fileIndex}.bin`);
    }
    attachmentPath(ticketId, attachmentId) {
        return path.join(this.rootDir, 'attachments', seg(ticketId), attachmentId);
    }
    /** Durably write a chunk payload (temp file + fsync + rename). */
    writeChunk(uploadKey, chunk, bytes) {
        writeFileAtomic(this.chunkPath(uploadKey, chunk.fileIndex, chunk.chunkIndex), bytes);
    }
    readChunk(uploadKey, fileIndex, chunkIndex) {
        return fs.readFileSync(this.chunkPath(uploadKey, fileIndex, chunkIndex));
    }
    /**
     * Assemble chunk files in order into `destPath` (atomic write),
     * returning the hex SHA-256 of the assembled bytes.
     */
    assembleFile(chunkPaths, destPath) {
        const hash = (0, node_crypto_1.createHash)('sha256');
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const tmp = `${destPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        const fd = fs.openSync(tmp, 'w');
        try {
            for (const p of chunkPaths) {
                const data = fs.readFileSync(p);
                hash.update(data);
                fs.writeFileSync(fd, data);
            }
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, destPath);
        fsyncDir(path.dirname(destPath));
        return hash.digest('hex');
    }
    /**
     * Durably move a staged candidate into its final attachment location.
     * If the final file already exists (same content-addressed identity),
     * the staged copy is simply discarded.
     */
    publishFile(stagingPath, finalPath) {
        if (fs.existsSync(finalPath)) {
            fs.rmSync(stagingPath, { force: true });
            return;
        }
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.renameSync(stagingPath, finalPath);
        fsyncDir(path.dirname(finalPath));
    }
    exists(p) {
        return fs.existsSync(p);
    }
    removeBatchArtifacts(uploadKey) {
        fs.rmSync(path.join(this.rootDir, 'chunks', seg(uploadKey)), { recursive: true, force: true });
        fs.rmSync(path.join(this.rootDir, 'staging', seg(uploadKey)), { recursive: true, force: true });
    }
    /**
     * Delete unreferenced files left behind by interrupted operations:
     * - chunk/staging dirs of terminal batches
     * - all staging dirs (candidates are rebuilt on retry)
     * - chunk files of open batches that have no metadata row
     * - attachment files with no metadata row
     * Chunks of still-resumable batches that are confirmed in metadata are kept.
     */
    sweep(terminalBatchKeys, validChunkPaths, referencedAttachmentPaths) {
        const chunksRoot = path.join(this.rootDir, 'chunks');
        for (const key of terminalBatchKeys) {
            fs.rmSync(path.join(chunksRoot, seg(key)), { recursive: true, force: true });
            fs.rmSync(path.join(this.rootDir, 'staging', seg(key)), { recursive: true, force: true });
        }
        // Staging candidates are always safe to drop: commit reassembles them.
        fs.rmSync(path.join(this.rootDir, 'staging'), { recursive: true, force: true });
        fs.mkdirSync(path.join(this.rootDir, 'staging'), { recursive: true });
        // Orphan chunk files (no metadata row) of open batches.
        if (fs.existsSync(chunksRoot)) {
            for (const keyDir of fs.readdirSync(chunksRoot)) {
                const kd = path.join(chunksRoot, keyDir);
                for (const fDir of fs.readdirSync(kd)) {
                    const fd = path.join(kd, fDir);
                    for (const file of fs.readdirSync(fd)) {
                        const p = path.join(fd, file);
                        if (!validChunkPaths.has(p))
                            fs.rmSync(p, { force: true });
                    }
                    if (fs.readdirSync(fd).length === 0)
                        fs.rmdirSync(fd);
                }
                if (fs.readdirSync(kd).length === 0)
                    fs.rmdirSync(kd);
            }
        }
        // Unreferenced published files.
        const attRoot = path.join(this.rootDir, 'attachments');
        if (fs.existsSync(attRoot)) {
            for (const ticketDir of fs.readdirSync(attRoot)) {
                const td = path.join(attRoot, ticketDir);
                for (const file of fs.readdirSync(td)) {
                    const p = path.join(td, file);
                    if (!referencedAttachmentPaths.has(p))
                        fs.rmSync(p, { force: true });
                }
                if (fs.readdirSync(td).length === 0)
                    fs.rmdirSync(td);
            }
        }
    }
}
exports.FileStore = FileStore;
