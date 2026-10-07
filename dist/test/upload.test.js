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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const service_1 = require("../src/service");
const types_1 = require("../src/types");
const fixture_1 = require("./helpers/fixture");
const SCENARIO = path.join(__dirname, 'helpers', 'scenario.js');
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crashlens-'));
}
function runScenario(name, dir) {
    const r = (0, node_child_process_1.spawnSync)(process.execPath, [SCENARIO, name, dir], { encoding: 'utf8' });
    const lines = r.stdout
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    return { status: r.status, signal: r.signal, lines };
}
function attachmentFiles(dir, ticketId) {
    const p = path.join(dir, 'attachments', encodeURIComponent(ticketId));
    return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}
const FILE_A = (0, fixture_1.makeBytes)(1, 2 * types_1.CHUNK_SIZE + 100);
const FILE_B = (0, fixture_1.makeBytes)(2, types_1.CHUNK_SIZE + 50);
const FILE_C = (0, fixture_1.makeBytes)(3, 2 * types_1.CHUNK_SIZE);
const FILE_D = (0, fixture_1.makeBytes)(4, 300);
(0, node_test_1.test)('begin: identical retry reuses batch, changed declaration is rejected', () => {
    const dir = tmpDir();
    const svc = new service_1.ScreenshotUploadService(dir);
    const decl = [(0, fixture_1.declOf)(FILE_B)];
    const first = svc.begin('K', 'T', decl);
    strict_1.default.equal(first.reused, false);
    const retry = svc.begin('K', 'T', decl);
    strict_1.default.equal(retry.reused, true);
    strict_1.default.equal(retry.state, 'open');
    strict_1.default.throws(() => svc.begin('K', 'T', [(0, fixture_1.declOf)(FILE_C)]), (e) => {
        strict_1.default.equal(e.code, 'DECLARATION_MISMATCH');
        return true;
    });
    strict_1.default.throws(() => svc.begin('K', 'OTHER', decl), (e) => {
        strict_1.default.equal(e.code, 'DECLARATION_MISMATCH');
        return true;
    });
    // Original batch unchanged.
    const insp = svc.inspect('K');
    strict_1.default.equal(insp.ticketId, 'T');
    strict_1.default.equal(insp.state, 'open');
    svc.close();
});
(0, node_test_1.test)('begin: validates declaration shape', () => {
    const dir = tmpDir();
    const svc = new service_1.ScreenshotUploadService(dir);
    strict_1.default.throws(() => svc.begin('K', 'T', []), /1 to 5/);
    strict_1.default.throws(() => svc.begin('K', 'T', Array.from({ length: 6 }, () => (0, fixture_1.declOf)(FILE_D))), /1 to 5/);
    strict_1.default.throws(() => svc.begin('K', 'T', [{ byteLength: -1, sha256: '0'.repeat(64) }]), /byteLength/);
    strict_1.default.throws(() => svc.begin('K', 'T', [{ byteLength: 1, sha256: 'zz' }]), /sha256/);
    svc.close();
});
(0, node_test_1.test)('putChunk: validation, identical retry, conflict rejection, incomplete commit', () => {
    const dir = tmpDir();
    const svc = new service_1.ScreenshotUploadService(dir);
    svc.begin('K', 'T', [(0, fixture_1.declOf)(FILE_B)]); // 2 chunks
    strict_1.default.throws(() => svc.putChunk('K', 1, 0, (0, fixture_1.chunkOf)(FILE_B, 0)), /out of range/);
    strict_1.default.throws(() => svc.putChunk('K', 0, 2, (0, fixture_1.chunkOf)(FILE_B, 0)), /out of range/);
    strict_1.default.throws(() => svc.putChunk('K', 0, 0, Buffer.alloc(10)), /must be/);
    svc.putChunk('K', 0, 0, (0, fixture_1.chunkOf)(FILE_B, 0));
    svc.putChunk('K', 0, 0, (0, fixture_1.chunkOf)(FILE_B, 0)); // identical retry: no-op
    strict_1.default.throws(() => svc.putChunk('K', 0, 0, (0, fixture_1.makeBytes)(999, types_1.CHUNK_SIZE)), (e) => {
        strict_1.default.equal(e.code, 'CHUNK_CONFLICT');
        return true;
    });
    const res = svc.commit('K');
    strict_1.default.equal(res.status, 'incomplete');
    if (res.status === 'incomplete') {
        strict_1.default.deepEqual(res.missing.map((m) => [m.fileIndex, m.chunkIndex]), [[0, 1]]);
    }
    // Batch stays open and resumable.
    svc.putChunk('K', 0, 1, (0, fixture_1.chunkOf)(FILE_B, 1));
    const done = svc.commit('K');
    strict_1.default.equal(done.status, 'committed');
    svc.close();
});
(0, node_test_1.test)('out-of-order chunks survive SIGKILL restart; retries and conflicts behave', () => {
    const dir = tmpDir();
    const crash = runScenario('outoforder-a', dir);
    strict_1.default.equal(crash.signal, 'SIGKILL');
    const resume = runScenario('outoforder-b', dir);
    strict_1.default.equal(resume.status, 0, JSON.stringify(resume));
    const inspect = resume.lines[0];
    strict_1.default.equal(inspect.state, 'open');
    strict_1.default.deepEqual(inspect.accepted.map((c) => [c.fileIndex, c.chunkIndex]), [
        [0, 0],
        [0, 2],
    ]);
    const conflict = resume.lines[1];
    strict_1.default.equal(conflict.conflict, 'CHUNK_CONFLICT');
    const commit = resume.lines[2];
    strict_1.default.equal(commit.result.status, 'committed');
    const att = commit.result.attachments[0];
    strict_1.default.equal(att.attachmentId, `att_${(0, fixture_1.sha256Hex)(FILE_A)}`);
    strict_1.default.deepEqual(fs.readFileSync(att.path), FILE_A);
});
for (const [name, crashScenario] of [
    ['after staging', 'twofile-crash-after-staging'],
    ['between file publish and commit record', 'twofile-crash-before-record'],
    ['after commit record, before return', 'twofile-crash-after-record'],
]) {
    (0, node_test_1.test)(`two files: SIGKILL ${name} -> all-or-nothing, stable ids`, () => {
        const dir = tmpDir();
        const crash = runScenario(crashScenario, dir);
        strict_1.default.equal(crash.signal, 'SIGKILL');
        const verify = runScenario('twofile-verify', dir);
        strict_1.default.equal(verify.status, 0, JSON.stringify(verify));
        const before = verify.lines[0];
        const commit = verify.lines[1];
        const again = verify.lines[2];
        if (crashScenario === 'twofile-crash-after-record') {
            // Commit was already effective: reopen must see the terminal state.
            strict_1.default.equal(before.state, 'committed');
            strict_1.default.equal(before.ticketAttachments.length, 2);
        }
        else {
            // Commit never recorded: nothing may be published.
            strict_1.default.equal(before.state, 'open');
            strict_1.default.equal(before.ticketAttachments.length, 0);
        }
        strict_1.default.equal(commit.result.status, 'committed');
        const atts = commit.result.attachments;
        strict_1.default.equal(atts.length, 2);
        strict_1.default.equal(atts[0].attachmentId, `att_${(0, fixture_1.sha256Hex)(FILE_B)}`);
        strict_1.default.equal(atts[1].attachmentId, `att_${(0, fixture_1.sha256Hex)(FILE_C)}`);
        strict_1.default.deepEqual(fs.readFileSync(atts[0].path), FILE_B);
        strict_1.default.deepEqual(fs.readFileSync(atts[1].path), FILE_C);
        // Repeated commit returns the identical terminal result.
        strict_1.default.deepEqual(again.result, commit.result);
        // Exactly one file per attachment; no leftover chunks/staging.
        strict_1.default.equal(attachmentFiles(dir, 'T2').length, 2);
        strict_1.default.ok(!fs.existsSync(path.join(dir, 'chunks', 'K2')));
        strict_1.default.ok(!fs.existsSync(path.join(dir, 'staging', 'K2')));
    });
}
(0, node_test_1.test)('dedup across batches; corrupted re-upload fails; failing batch publishes nothing', () => {
    const dir = tmpDir();
    const first = runScenario('dedup-first', dir);
    strict_1.default.equal(first.status, 0);
    const firstCommit = first.lines[0]
        .result;
    const second = runScenario('dedup-second-same-content', dir);
    strict_1.default.equal(second.status, 0);
    const secondCommit = second.lines[0]
        .result;
    // Same content in a different batch -> same stable id, same single file.
    strict_1.default.deepEqual(secondCommit.attachments, firstCommit.attachments);
    strict_1.default.equal(attachmentFiles(dir, 'T3').length, 1);
    strict_1.default.deepEqual(fs.readFileSync(firstCommit.attachments[0].path), FILE_D);
    // Corrupted bytes under an already-published declaration must still fail.
    const corrupted = runScenario('dedup-corrupted-reupload', dir);
    strict_1.default.equal(corrupted.status, 0);
    const corruptedLine = corrupted.lines[0];
    strict_1.default.equal(corruptedLine.first.status, 'failed');
    strict_1.default.equal(corruptedLine.state, 'failed');
    strict_1.default.equal(corruptedLine.ticketAttachments.length, 1);
    strict_1.default.deepEqual(fs.readFileSync(firstCommit.attachments[0].path), FILE_D);
    // Batch with one good file and one bad declaration fails as a whole.
    const failing = runScenario('dedup-failing-batch', dir);
    strict_1.default.equal(failing.status, 0);
    const line = failing.lines[0];
    strict_1.default.equal(line.first.status, 'failed');
    strict_1.default.match(line.first.reason, /sha256 mismatch on file 1/);
    // Failure is terminal and repeatable.
    strict_1.default.deepEqual(line.second, line.first);
    strict_1.default.equal(line.state, 'failed');
    // No new attachments for the ticket (still only the deduped one).
    strict_1.default.equal(line.ticketAttachments.length, 1);
    strict_1.default.equal(attachmentFiles(dir, 'T3').length, 1);
    // Failed batch artifacts are cleaned.
    strict_1.default.ok(!fs.existsSync(path.join(dir, 'chunks', 'D3')));
    strict_1.default.ok(!fs.existsSync(path.join(dir, 'staging', 'D3')));
});
(0, node_test_1.test)('duplicate content within one batch yields one file and one stable id', () => {
    const dir = tmpDir();
    const r = runScenario('samebatch-dup', dir);
    strict_1.default.equal(r.status, 0);
    const commit = r.lines[0]
        .result;
    strict_1.default.equal(commit.attachments.length, 2);
    strict_1.default.equal(commit.attachments[0].attachmentId, commit.attachments[1].attachmentId);
    strict_1.default.equal(commit.attachments[0].path, commit.attachments[1].path);
    strict_1.default.equal(attachmentFiles(dir, 'T4').length, 1);
    strict_1.default.deepEqual(fs.readFileSync(commit.attachments[0].path), FILE_D);
});
(0, node_test_1.test)('reopen sweeps orphans but keeps confirmed chunks of open batches', () => {
    const dir = tmpDir();
    const svc = new service_1.ScreenshotUploadService(dir);
    svc.begin('K', 'T', [(0, fixture_1.declOf)(FILE_B)]);
    svc.putChunk('K', 0, 0, (0, fixture_1.chunkOf)(FILE_B, 0));
    svc.close();
    // Plant orphans: unrecorded chunk, stale staging candidate, stray attachment.
    const orphanChunk = path.join(dir, 'chunks', 'K', '0', '9.part');
    fs.mkdirSync(path.dirname(orphanChunk), { recursive: true });
    fs.writeFileSync(orphanChunk, Buffer.alloc(4));
    const staleStaging = path.join(dir, 'staging', 'K', '0.bin');
    fs.mkdirSync(path.dirname(staleStaging), { recursive: true });
    fs.writeFileSync(staleStaging, Buffer.alloc(4));
    const strayAttachment = path.join(dir, 'attachments', 'T', 'att_stray');
    fs.mkdirSync(path.dirname(strayAttachment), { recursive: true });
    fs.writeFileSync(strayAttachment, Buffer.alloc(4));
    const reopened = new service_1.ScreenshotUploadService(dir);
    const insp = reopened.inspect('K');
    // Confirmed chunk survives; orphans are gone and never reported.
    strict_1.default.deepEqual(insp.acceptedChunks.map((c) => [c.fileIndex, c.chunkIndex]), [[0, 0]]);
    strict_1.default.ok(!fs.existsSync(orphanChunk));
    strict_1.default.ok(!fs.existsSync(staleStaging));
    strict_1.default.ok(!fs.existsSync(strayAttachment));
    strict_1.default.ok(fs.existsSync(path.join(dir, 'chunks', 'K', '0', '0.part')));
    // Batch is still resumable to a correct commit.
    reopened.putChunk('K', 0, 1, (0, fixture_1.chunkOf)(FILE_B, 1));
    const res = reopened.commit('K');
    strict_1.default.equal(res.status, 'committed');
    reopened.close();
});
(0, node_test_1.test)('zero-length file commits correctly', () => {
    const dir = tmpDir();
    const svc = new service_1.ScreenshotUploadService(dir);
    const empty = Buffer.alloc(0);
    svc.begin('K', 'T', [(0, fixture_1.declOf)(empty)]);
    const res = svc.commit('K');
    strict_1.default.equal(res.status, 'committed');
    if (res.status === 'committed') {
        strict_1.default.equal(fs.readFileSync(res.attachments[0].path).length, 0);
        strict_1.default.equal(res.attachments[0].attachmentId, `att_${(0, fixture_1.sha256Hex)(empty)}`);
    }
    svc.close();
});
(0, node_test_1.test)('operations on unknown or closed batches are rejected', () => {
    const dir = tmpDir();
    const svc = new service_1.ScreenshotUploadService(dir);
    strict_1.default.throws(() => svc.inspect('nope'), (e) => {
        strict_1.default.equal(e.code, 'BATCH_NOT_FOUND');
        return true;
    });
    strict_1.default.throws(() => svc.putChunk('nope', 0, 0, Buffer.alloc(1)), (e) => {
        strict_1.default.equal(e.code, 'BATCH_NOT_FOUND');
        return true;
    });
    svc.begin('K', 'T', [(0, fixture_1.declOf)(FILE_D)]);
    svc.putChunk('K', 0, 0, (0, fixture_1.chunkOf)(FILE_D, 0));
    strict_1.default.equal(svc.commit('K').status, 'committed');
    strict_1.default.throws(() => svc.putChunk('K', 0, 0, (0, fixture_1.chunkOf)(FILE_D, 0)), (e) => {
        strict_1.default.equal(e.code, 'BATCH_CLOSED');
        return true;
    });
    svc.close();
});
