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
/**
 * Child-process scenarios. Each invocation is a fresh process that opens the
 * storage directory, performs one phase, and either exits normally or kills
 * itself with SIGKILL at a persistence boundary (never via thrown errors).
 * Results are printed to stdout as JSON lines for the parent to assert on.
 */
const fs = __importStar(require("node:fs"));
const service_1 = require("../../src/service");
const types_1 = require("../../src/types");
const fixture_1 = require("./fixture");
function die() {
    process.kill(process.pid, 'SIGKILL');
    // Unreachable in practice; keeps the type checker happy if the signal
    // delivery were ever delayed.
    setTimeout(() => process.exit(137), 5000);
    // eslint-disable-next-line no-constant-condition
    while (true) { }
}
function say(obj) {
    fs.writeSync(1, JSON.stringify(obj) + '\n');
}
const FILE_A = (0, fixture_1.makeBytes)(1, 2 * types_1.CHUNK_SIZE + 100); // 3 chunks
const FILE_B = (0, fixture_1.makeBytes)(2, types_1.CHUNK_SIZE + 50); // 2 chunks
const FILE_C = (0, fixture_1.makeBytes)(3, 2 * types_1.CHUNK_SIZE); // 2 chunks
const FILE_D = (0, fixture_1.makeBytes)(4, 300); // 1 chunk
function putAll(svc, key, fileIndex, bytes) {
    const count = bytes.length === 0 ? 0 : Math.ceil(bytes.length / types_1.CHUNK_SIZE);
    for (let i = 0; i < count; i++)
        svc.putChunk(key, fileIndex, i, (0, fixture_1.chunkOf)(bytes, i));
}
const scenario = process.argv[2];
const dir = process.argv[3];
switch (scenario) {
    // --- Scenario 1: out-of-order chunks, crash mid-upload, then resume ---
    case 'outoforder-a': {
        const svc = new service_1.ScreenshotUploadService(dir);
        svc.begin('K1', 'T1', [(0, fixture_1.declOf)(FILE_A)]);
        svc.putChunk('K1', 0, 2, (0, fixture_1.chunkOf)(FILE_A, 2));
        svc.putChunk('K1', 0, 0, (0, fixture_1.chunkOf)(FILE_A, 0));
        svc.close();
        die(); // killed after two confirmed chunks, chunk 1 still missing
    }
    case 'outoforder-b': {
        const svc = new service_1.ScreenshotUploadService(dir);
        const before = svc.inspect('K1');
        say({ phase: 'inspect-after-reopen', accepted: before.acceptedChunks, state: before.state });
        // Identical retry: no-op.
        svc.putChunk('K1', 0, 0, (0, fixture_1.chunkOf)(FILE_A, 0));
        // Conflicting retry: must be rejected and must not overwrite.
        let conflict = null;
        try {
            svc.putChunk('K1', 0, 0, (0, fixture_1.makeBytes)(999, types_1.CHUNK_SIZE));
        }
        catch (e) {
            conflict = e.code ?? 'UNKNOWN';
        }
        say({ phase: 'conflict-retry', conflict });
        svc.putChunk('K1', 0, 1, (0, fixture_1.chunkOf)(FILE_A, 1));
        const result = svc.commit('K1');
        say({ phase: 'commit', result });
        svc.close();
        break;
    }
    // --- Scenario 2: two files, crash at each commit persistence boundary ---
    case 'twofile-crash-after-staging':
    case 'twofile-crash-before-record':
    case 'twofile-crash-after-record': {
        const hookName = scenario === 'twofile-crash-after-staging'
            ? 'afterStaging'
            : scenario === 'twofile-crash-before-record'
                ? 'beforeCommitRecord'
                : 'afterCommitRecord';
        const svc = new service_1.ScreenshotUploadService(dir, { hooks: { [hookName]: () => die() } });
        svc.begin('K2', 'T2', [(0, fixture_1.declOf)(FILE_B), (0, fixture_1.declOf)(FILE_C)]);
        putAll(svc, 'K2', 0, FILE_B);
        putAll(svc, 'K2', 1, FILE_C);
        svc.commit('K2'); // dies inside the hook
        svc.close();
        break;
    }
    case 'twofile-verify': {
        const svc = new service_1.ScreenshotUploadService(dir);
        const before = svc.inspect('K2');
        say({
            phase: 'inspect-after-reopen',
            state: before.state,
            ticketAttachments: before.ticketAttachments,
            commitResult: before.commitResult ?? null,
        });
        const result = svc.commit('K2');
        say({ phase: 'commit', result });
        const again = svc.commit('K2');
        say({ phase: 'commit-again', result: again });
        svc.close();
        break;
    }
    // --- Scenario 3: dedup across batches + a failing batch ---
    case 'dedup-first': {
        const svc = new service_1.ScreenshotUploadService(dir);
        svc.begin('D1', 'T3', [(0, fixture_1.declOf)(FILE_D)]);
        putAll(svc, 'D1', 0, FILE_D);
        say({ phase: 'commit', result: svc.commit('D1') });
        svc.close();
        break;
    }
    case 'dedup-second-same-content': {
        const svc = new service_1.ScreenshotUploadService(dir);
        svc.begin('D2', 'T3', [(0, fixture_1.declOf)(FILE_D)]);
        putAll(svc, 'D2', 0, FILE_D);
        say({ phase: 'commit', result: svc.commit('D2') });
        svc.close();
        break;
    }
    case 'dedup-failing-batch': {
        const svc = new service_1.ScreenshotUploadService(dir);
        const badDecl = { byteLength: FILE_B.length, sha256: '0'.repeat(64) };
        svc.begin('D3', 'T3', [(0, fixture_1.declOf)(FILE_A), badDecl]);
        putAll(svc, 'D3', 0, FILE_A);
        putAll(svc, 'D3', 1, FILE_B);
        const first = svc.commit('D3');
        const second = svc.commit('D3');
        const insp = svc.inspect('D3');
        say({
            phase: 'failed-commit',
            first,
            second,
            state: insp.state,
            ticketAttachments: insp.ticketAttachments,
        });
        svc.close();
        break;
    }
    // Same declared digest as an existing attachment, but corrupted bytes:
    // the service must hash the actual upload and fail, not trust the decl.
    case 'dedup-corrupted-reupload': {
        const svc = new service_1.ScreenshotUploadService(dir);
        svc.begin('D4', 'T3', [(0, fixture_1.declOf)(FILE_D)]);
        const corrupted = Buffer.from(FILE_D);
        corrupted[0] ^= 0xff;
        putAll(svc, 'D4', 0, corrupted);
        const first = svc.commit('D4');
        const insp = svc.inspect('D4');
        say({ phase: 'failed-commit', first, state: insp.state, ticketAttachments: insp.ticketAttachments });
        svc.close();
        break;
    }
    // --- Scenario 4: duplicate content within one batch ---
    case 'samebatch-dup': {
        const svc = new service_1.ScreenshotUploadService(dir);
        svc.begin('S1', 'T4', [(0, fixture_1.declOf)(FILE_D), (0, fixture_1.declOf)(FILE_D)]);
        putAll(svc, 'S1', 0, FILE_D);
        putAll(svc, 'S1', 1, FILE_D);
        say({ phase: 'commit', result: svc.commit('S1') });
        svc.close();
        break;
    }
    default:
        console.error(`unknown scenario ${scenario}`);
        process.exit(2);
}
