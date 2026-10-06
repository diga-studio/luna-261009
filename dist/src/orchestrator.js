/**
 * 保护组可恢复计划切换编排库。
 *
 * 编排状态存 SQLite（node:sqlite），与执行器持久化相互独立。
 * 等待执行器回复时不持有数据库事务；每条指令结果落盘后再发下一条。
 * 指令 ID 由 (groupId, requestId, seq) 确定性派生，恢复时重放同 ID，
 * 由执行器去重，绝不换用新 ID。
 */
import { DatabaseSync } from "node:sqlite";
const other = (s) => (s === "A" ? "B" : "A");
export class Orchestrator {
    db;
    executor;
    constructor(options) {
        this.executor = options.executor;
        this.db = new DatabaseSync(options.dbPath);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        active_site TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        group_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        PRIMARY KEY (group_id, vm_id)
      );
      CREATE TABLE IF NOT EXISTS requests (
        group_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        from_site TEXT NOT NULL,
        to_site TEXT NOT NULL,
        phase TEXT NOT NULL,
        outcome TEXT,
        created_seq INTEGER PRIMARY KEY AUTOINCREMENT
      );
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        phase TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        site TEXT NOT NULL,
        op TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT
      );
    `);
    }
    /** 建立保护组初始状态：A 端全部运行、B 端全部停止。 */
    async createGroup(groupId, vmIds) {
        if (vmIds.length < 1 || vmIds.length > 50) {
            throw new Error("group must have 1..50 VMs");
        }
        if (new Set(vmIds).size !== vmIds.length) {
            throw new Error("duplicate vmIds");
        }
        const existing = this.db
            .prepare("SELECT group_id FROM groups WHERE group_id = ?")
            .get(groupId);
        if (existing)
            throw new Error(`group ${groupId} already exists`);
        this.db.exec("BEGIN");
        try {
            this.db
                .prepare("INSERT INTO groups (group_id, active_site) VALUES (?, 'A')")
                .run(groupId);
            const ins = this.db.prepare("INSERT INTO members (group_id, vm_id) VALUES (?, ?)");
            for (const vmId of vmIds)
                ins.run(groupId, vmId);
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        // 登记执行器侧副本初始状态（幂等，非 VM 操作）。
        for (const vmId of vmIds) {
            await this.executor.register(vmId, "A", "running");
            await this.executor.register(vmId, "B", "stopped");
        }
    }
    /**
     * 计划切换 / 故障回切到另一站。
     * 同 requestId 重放：继续原请求或返回其原有终态，不再次切换。
     */
    async switchGroup(groupId, requestId) {
        const group = this.getGroup(groupId);
        const existing = this.getRequest(groupId, requestId);
        if (!existing) {
            const unfinished = this.db
                .prepare("SELECT request_id FROM requests WHERE group_id = ? AND phase != 'DONE'")
                .get(groupId);
            if (unfinished) {
                throw new Error(`group ${groupId} has an unfinished request: ${unfinished.request_id}`);
            }
            const fromSite = group.active_site;
            const toSite = other(fromSite);
            this.createRequestPlan(groupId, requestId, fromSite, toSite);
        }
        return this.drive(groupId, requestId);
    }
    /** 继续所有未完成请求，直到全部收敛到终态。 */
    async recover() {
        const rows = this.db
            .prepare("SELECT group_id, request_id FROM requests WHERE phase != 'DONE' ORDER BY created_seq")
            .all();
        for (const row of rows) {
            await this.drive(row.group_id, row.request_id);
        }
    }
    /** 读取活动站点、请求状态和成员两端实际状态。 */
    async inspect(groupId) {
        const group = this.getGroup(groupId);
        const req = this.db
            .prepare("SELECT * FROM requests WHERE group_id = ? ORDER BY " +
            "CASE WHEN phase != 'DONE' THEN 0 ELSE 1 END, created_seq DESC LIMIT 1")
            .get(groupId);
        const replicas = await this.executor.queryState();
        const byVm = new Map();
        for (const r of replicas) {
            const entry = byVm.get(r.vmId) ?? {};
            if (r.site === "A")
                entry.a = r.state;
            else
                entry.b = r.state;
            byVm.set(r.vmId, entry);
        }
        const members = this.db
            .prepare("SELECT vm_id FROM members WHERE group_id = ? ORDER BY vm_id")
            .all(groupId).map((m) => {
            const states = byVm.get(m.vm_id) ?? {};
            return {
                vmId: m.vm_id,
                a: (states.a ?? "stopped"),
                b: (states.b ?? "stopped"),
            };
        });
        return {
            groupId,
            activeSite: group.active_site,
            request: req
                ? {
                    requestId: req.request_id,
                    fromSite: req.from_site,
                    toSite: req.to_site,
                    phase: req.phase,
                    outcome: req.outcome ?? null,
                }
                : null,
            members,
        };
    }
    close() {
        this.db.close();
    }
    getGroup(groupId) {
        const row = this.db
            .prepare("SELECT * FROM groups WHERE group_id = ?")
            .get(groupId);
        if (!row)
            throw new Error(`group ${groupId} not found`);
        return row;
    }
    getRequest(groupId, requestId) {
        return this.db
            .prepare("SELECT * FROM requests WHERE group_id = ? AND request_id = ?")
            .get(groupId, requestId);
    }
    /** 在单个事务中写入请求及其全部四个阶段的确定性指令计划。 */
    createRequestPlan(groupId, requestId, fromSite, toSite) {
        const members = this.db
            .prepare("SELECT vm_id FROM members WHERE group_id = ? ORDER BY vm_id")
            .all(groupId);
        this.db.exec("BEGIN");
        try {
            this.db
                .prepare("INSERT INTO requests (group_id, request_id, from_site, to_site, phase, outcome) " +
                "VALUES (?, ?, ?, ?, 'STOP_SOURCE', NULL)")
                .run(groupId, requestId, fromSite, toSite);
            const ins = this.db.prepare("INSERT INTO commands (command_id, group_id, request_id, seq, phase, vm_id, site, op, status, outcome) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)");
            let seq = 0;
            const plan = [
                ["STOP_SOURCE", fromSite, "stop"],
                ["START_TARGET", toSite, "start"],
                ["STOP_TARGET", toSite, "stop"],
                ["START_SOURCE", fromSite, "start"],
            ];
            for (const [phase, site, op] of plan) {
                for (const m of members) {
                    ins.run(`${groupId}:${requestId}:${seq}`, groupId, requestId, seq, phase, m.vm_id, site, op);
                    seq += 1;
                }
            }
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }
    /**
     * 驱动状态机直到请求到达终态。
     * 每次只等待一条执行器指令，等待期间不持有任何事务。
     */
    async drive(groupId, requestId) {
        for (;;) {
            const req = this.getRequest(groupId, requestId);
            if (!req)
                throw new Error(`request ${requestId} not found`);
            if (req.phase === "DONE") {
                const group = this.getGroup(groupId);
                return {
                    outcome: req.outcome,
                    activeSite: group.active_site,
                };
            }
            const cmd = this.db
                .prepare("SELECT * FROM commands WHERE group_id = ? AND request_id = ? AND phase = ? " +
                "AND status = 'pending' ORDER BY seq LIMIT 1")
                .get(groupId, requestId, req.phase);
            if (cmd) {
                const outcome = await this.executor.exec(cmd.command_id, cmd.vm_id, cmd.site, cmd.op);
                if (cmd.op === "stop" && outcome === "rejected") {
                    throw new Error(`stop command ${cmd.command_id} was rejected`);
                }
                this.db
                    .prepare("UPDATE commands SET status = 'done', outcome = ? WHERE command_id = ?")
                    .run(outcome, cmd.command_id);
                // 目标端启动被永久拒绝：立即中止本阶段，进入回滚。
                if (cmd.phase === "START_TARGET" && outcome === "rejected") {
                    this.advancePhase(req);
                }
                continue;
            }
            this.advancePhase(req);
        }
    }
    /** 当前阶段指令全部完成后推进状态机（单事务）。 */
    advancePhase(req) {
        const setPhase = this.db.prepare("UPDATE requests SET phase = ?, outcome = ? WHERE group_id = ? AND request_id = ?");
        this.db.exec("BEGIN");
        try {
            switch (req.phase) {
                case "STOP_SOURCE":
                    setPhase.run("START_TARGET", null, req.group_id, req.request_id);
                    break;
                case "START_TARGET": {
                    const rejected = this.db
                        .prepare("SELECT COUNT(*) AS n FROM commands WHERE group_id = ? AND request_id = ? " +
                        "AND phase = 'START_TARGET' AND outcome = 'rejected'")
                        .get(req.group_id, req.request_id);
                    if (rejected.n > 0) {
                        // 目标端有启动被永久拒绝：回滚。
                        setPhase.run("STOP_TARGET", null, req.group_id, req.request_id);
                    }
                    else {
                        // 整组完成：翻转活动站点并记成功。
                        setPhase.run("DONE", "success", req.group_id, req.request_id);
                        this.db
                            .prepare("UPDATE groups SET active_site = ? WHERE group_id = ?")
                            .run(req.to_site, req.group_id);
                    }
                    break;
                }
                case "STOP_TARGET":
                    setPhase.run("START_SOURCE", null, req.group_id, req.request_id);
                    break;
                case "START_SOURCE":
                    // 源端全员运行后记录失败；活动站点不变。
                    setPhase.run("DONE", "failure", req.group_id, req.request_id);
                    break;
                default:
                    throw new Error(`cannot advance from phase ${req.phase}`);
            }
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }
}
//# sourceMappingURL=orchestrator.js.map