/**
 * 本机 VM 执行器进程。
 *
 * 独立进程、独立 SQLite 持久化，与编排库不共享事务。
 * 通过 process IPC 接收单台副本的 start/stop 指令。
 * 指令携带稳定 commandId：成功与永久拒绝都会持久化，
 * 同 ID 重放返回原结果且不再次生效。
 *
 * 测试钩子：
 *  - pauseAt(beforeApply|beforeReply, commandId)：在生效前 /
 *    生效已持久化但回复前暂停（一次性，持久化保存，命中即清除）。
 *  - armReject(commandId)：让该 ID 的 start 指令被永久拒绝
 *    （无副作用，结果同样持久化）。
 */
import { DatabaseSync } from "node:sqlite";
export function runExecutorMain(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS replicas (
      vm_id TEXT NOT NULL,
      site TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (vm_id, site)
    );
    CREATE TABLE IF NOT EXISTS commands (
      command_id TEXT PRIMARY KEY,
      vm_id TEXT NOT NULL,
      site TEXT NOT NULL,
      op TEXT NOT NULL,
      outcome TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL,
      vm_id TEXT NOT NULL,
      site TEXT NOT NULL,
      op TEXT NOT NULL,
      outcome TEXT NOT NULL,
      applied INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rejections (
      command_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS pauses (
      command_id TEXT NOT NULL,
      point TEXT NOT NULL,
      PRIMARY KEY (command_id, point)
    );
  `);
    const send = (msg) => {
        try {
            process.send?.(msg);
        }
        catch {
            // 父进程已退出，回复无处可去；结果已持久化，无妨。
        }
    };
    // 暂停协调：命中暂停点时阻塞消息队列，直到收到 resume。
    let resumeWaiter = null;
    const takePause = (commandId, point) => {
        const row = db
            .prepare("SELECT command_id FROM pauses WHERE command_id = ? AND point = ?")
            .get(commandId, point);
        if (!row)
            return false;
        db.prepare("DELETE FROM pauses WHERE command_id = ? AND point = ?").run(commandId, point);
        return true;
    };
    const maybePause = async (commandId, point) => {
        if (!takePause(commandId, point))
            return;
        send({ type: "paused", point, commandId });
        await new Promise((resolve) => {
            resumeWaiter = resolve;
        });
    };
    const recordHistory = (commandId, vmId, site, op, outcome, applied) => {
        db.prepare("INSERT INTO history (command_id, vm_id, site, op, outcome, applied) VALUES (?, ?, ?, ?, ?, ?)").run(commandId, vmId, site, op, outcome, applied);
    };
    const handleExec = async (commandId, vmId, site, op) => {
        // 去重：已有持久化结果则原样返回，不再生效。
        const existing = db
            .prepare("SELECT * FROM commands WHERE command_id = ?")
            .get(commandId);
        if (existing) {
            recordHistory(commandId, vmId, site, op, existing.outcome, 0);
            send({
                type: "result",
                commandId,
                outcome: existing.outcome,
            });
            return;
        }
        await maybePause(commandId, "beforeApply");
        const rejected = op === "start" &&
            db
                .prepare("SELECT command_id FROM rejections WHERE command_id = ?")
                .get(commandId) !== undefined;
        let outcome;
        let applied;
        if (rejected) {
            // 永久拒绝：无副作用，仅持久化结果。
            outcome = "rejected";
            applied = 0;
            db.prepare("INSERT INTO commands (command_id, vm_id, site, op, outcome) VALUES (?, ?, ?, ?, ?)").run(commandId, vmId, site, op, outcome);
            recordHistory(commandId, vmId, site, op, outcome, 0);
        }
        else {
            // 生效与结果持久化在同一个本地事务中完成。
            outcome = "ok";
            applied = 1;
            const newState = op === "start" ? "running" : "stopped";
            db.exec("BEGIN");
            try {
                db.prepare("INSERT INTO replicas (vm_id, site, state) VALUES (?, ?, ?) " +
                    "ON CONFLICT (vm_id, site) DO UPDATE SET state = excluded.state").run(vmId, site, newState);
                db.prepare("INSERT INTO commands (command_id, vm_id, site, op, outcome) VALUES (?, ?, ?, ?, ?)").run(commandId, vmId, site, op, outcome);
                recordHistory(commandId, vmId, site, op, outcome, 1);
                db.exec("COMMIT");
            }
            catch (err) {
                db.exec("ROLLBACK");
                throw err;
            }
        }
        await maybePause(commandId, "beforeReply");
        send({ type: "result", commandId, outcome });
    };
    const handleMessage = async (msg) => {
        switch (msg.type) {
            case "register":
                db.prepare("INSERT OR IGNORE INTO replicas (vm_id, site, state) VALUES (?, ?, ?)").run(msg.vmId, msg.site, msg.state);
                send({ type: "registered", vmId: msg.vmId, site: msg.site });
                return;
            case "exec":
                await handleExec(msg.commandId, msg.vmId, msg.site, msg.op);
                return;
            case "query": {
                const rows = db
                    .prepare("SELECT vm_id, site, state FROM replicas ORDER BY vm_id, site")
                    .all();
                send({
                    type: "state",
                    replicas: rows.map((r) => ({
                        vmId: r.vm_id,
                        site: r.site,
                        state: r.state,
                    })),
                });
                return;
            }
            case "armReject":
                db.prepare("INSERT OR IGNORE INTO rejections (command_id) VALUES (?)").run(msg.commandId);
                return;
            case "pauseAt":
                db.prepare("INSERT OR REPLACE INTO pauses (command_id, point) VALUES (?, ?)").run(msg.commandId, msg.point);
                return;
            case "resume":
                if (resumeWaiter) {
                    const wake = resumeWaiter;
                    resumeWaiter = null;
                    wake();
                }
                return;
            case "history": {
                const rows = db
                    .prepare("SELECT seq, command_id, vm_id, site, op, outcome, applied FROM history ORDER BY seq")
                    .all();
                send({
                    type: "history",
                    entries: rows.map((r) => ({
                        seq: r.seq,
                        commandId: r.command_id,
                        vmId: r.vm_id,
                        site: r.site,
                        op: r.op,
                        outcome: r.outcome,
                        applied: r.applied,
                    })),
                });
                return;
            }
            case "shutdown":
                send({ type: "ready" });
                db.close();
                process.exit(0);
        }
    };
    // 顺序处理消息，保证暂停时后续指令排队；
    // 但 resume 必须立即处理，否则暂停永远无法解除。
    let queue = Promise.resolve();
    process.on("message", (msg) => {
        if (msg.type === "resume") {
            void handleMessage(msg);
            return;
        }
        queue = queue.then(() => handleMessage(msg)).catch((err) => {
            // 单条消息异常不应杀死执行器。
            console.error("executor message error:", err);
        });
    });
    send({ type: "ready" });
}
if (process.argv[1] &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const dbPath = process.argv[2];
    if (!dbPath) {
        throw new Error("usage: executor.js <dbPath>");
    }
    runExecutorMain(dbPath);
}
//# sourceMappingURL=executor.js.map