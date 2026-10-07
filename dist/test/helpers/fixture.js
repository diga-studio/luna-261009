"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeBytes = makeBytes;
exports.sha256Hex = sha256Hex;
exports.declOf = declOf;
exports.chunkOf = chunkOf;
exports.chunkCount = chunkCount;
const node_crypto_1 = require("node:crypto");
const types_1 = require("../../src/types");
/** Deterministic pseudo-random bytes derived from a seed (SHA-256 chain). */
function makeBytes(seed, len) {
    const out = Buffer.alloc(len);
    let block = (0, node_crypto_1.createHash)('sha256').update(`seed:${seed}`).digest();
    let offset = 0;
    while (offset < len) {
        const n = Math.min(block.length, len - offset);
        block.copy(out, offset, 0, n);
        offset += n;
        block = (0, node_crypto_1.createHash)('sha256').update(block).digest();
    }
    return out;
}
function sha256Hex(bytes) {
    return (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
}
function declOf(bytes) {
    return { byteLength: bytes.length, sha256: sha256Hex(bytes) };
}
function chunkOf(bytes, chunkIndex) {
    const start = chunkIndex * types_1.CHUNK_SIZE;
    return Buffer.from(bytes.subarray(start, Math.min(start + types_1.CHUNK_SIZE, bytes.length)));
}
function chunkCount(byteLength) {
    return byteLength === 0 ? 0 : Math.ceil(byteLength / types_1.CHUNK_SIZE);
}
