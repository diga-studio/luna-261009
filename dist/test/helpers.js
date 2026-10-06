/** 测试辅助：临时目录、执行器库直读、故障注入、可杀子进程。 */
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutorClient } from "../src/executorClient.js";
import { Orchestrator } from "../src/orchestrator.js";
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
export async function setupEnv() {
    const dir = mkdtempSync(path.join(tmpdir(), "pgswitch-"));
    const orchDb = path.join(dir, "orch.db");
    const execDb = path.join(dir, "exec.db");
    const executor = new ExecutorClient({ dbPath: execDb });
    await executor.start();
    const orchestrator = new Orchestrator({ dbPath: orchDb, executor });
    return {
        dir,
        orchDb,
        execDb,
        executor,
        orchestrator,
        cleanup: async () => {
            orchestrator.close();
            await executor.shutdown();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
/** 直接打开执行器库做故障注入 / 核验（执行器历史必须可检查）。 */
export function withExecDb(execDb, fn) {
    const db = new DatabaseSync(execDb);
    try {
        return fn(db);
    }
    finally {
        db.close();
    }
}
export function armPause(execDb, commandId, point) {
    withExecDb(execDb, (db) => {
        db.prepare("INSERT OR REPLACE INTO pauses (command_id, point) VALUES (?, ?)").run(commandId, point);
    });
}
export function armReject(execDb, commandId) {
    withExecDb(execDb, (db) => {
        db.prepare("INSERT OR IGNORE INTO rejections (command_id) VALUES (?)").run(commandId);
    });
}
/** 轮询直到暂停点被命中（暂停是一次性的，命中即删除记录）。 */
export async function waitPauseHit(execDb, commandId, point, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const remaining = withExecDb(execDb, (db) => {
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM pauses WHERE command_id = ? AND point = ?")
                .get(commandId, point);
            return row.n;
        });
        if (remaining === 0)
            return;
        if (Date.now() > deadline) {
            throw new Error(`pause ${point} for ${commandId} not hit in time`);
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}
export function readHistory(execDb) {
    return withExecDb(execDb, (db) => {
        const rows = db
            .prepare("SELECT seq, command_id, vm_id, site, op, outcome, applied FROM history ORDER BY seq")
            .all();
        return rows.map((r) => ({
            seq: r.seq,
            commandId: r.command_id,
            vmId: r.vm_id,
            site: r.site,
            op: r.op,
            outcome: r.outcome,
            applied: r.applied,
        }));
    });
}
export function readReplicas(execDb) {
    return withExecDb(execDb, (db) => {
        const rows = db
            .prepare("SELECT vm_id, site, state FROM replicas ORDER BY vm_id, site")
            .all();
        return rows.map((r) => ({
            vmId: r.vm_id,
            site: r.site,
            state: r.state,
        }));
    });
}
function spawnWorker(args) {
    const child = spawn("node", args, {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
    });
    const done = new Promise((resolve, reject) => {
        child.on("exit", (code, signal) => {
            if (code === 0)
                resolve(0);
            else
                reject(new Error(`worker exited code=${code} signal=${signal}`));
        });
    });
    return {
        pid: child.pid,
        done,
        kill: () => {
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch {
                /* 已退出 */
            }
        },
    };
}
export function runSwitchWorker(orchDb, execDb, groupId, requestId) {
    return spawnWorker([
        path.join(srcDir, "switchWorker.js"),
        orchDb,
        execDb,
        groupId,
        requestId,
    ]);
}
export function runRecoverWorker(orchDb, execDb) {
    return spawnWorker([path.join(srcDir, "recoverWorker.js"), orchDb, execDb]);
}
/** 指令 ID 与编排库派生规则一致，仅供测试计算暂停/拒绝目标。 */
export function cmdId(groupId, requestId, seq) {
    return `${groupId}:${requestId}:${seq}`;
}
//# sourceMappingURL=helpers.js.map