import { FileDecl } from '../../src/types';
/** Deterministic pseudo-random bytes derived from a seed (SHA-256 chain). */
export declare function makeBytes(seed: number, len: number): Buffer;
export declare function sha256Hex(bytes: Uint8Array): string;
export declare function declOf(bytes: Uint8Array): FileDecl;
export declare function chunkOf(bytes: Uint8Array, chunkIndex: number): Buffer;
export declare function chunkCount(byteLength: number): number;
