/**
 * 编排进程侧的执行器客户端：负责 fork 执行器子进程、
 * 发送指令并等待结果、查询副本状态与执行历史。
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const defaultExecutorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "executor.js");
export class ExecutorClient {
    options;
    child = null;
    pending = new Map();
    waiters = [];
    readyPromise = null;
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.child)
            return;
        const execPath = this.options.executorPath ?? defaultExecutorPath;
        const child = fork(execPath, [this.options.dbPath], {
            stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        this.child = child;
        child.on("message", (msg) => this.dispatch(msg));
        child.on("exit", () => {
            this.child = null;
            const err = new Error("executor process exited");
            for (const p of this.pending.values())
                p.reject(err);
            this.pending.clear();
        });
        this.readyPromise = new Promise((resolve) => {
            this.waiters.push({
                match: (m) => m.type === "ready",
                resolve: () => resolve(),
            });
        });
        await this.readyPromise;
    }
    dispatch(msg) {
        if (msg.type === "result") {
            const p = this.pending.get(msg.commandId);
            if (p) {
                this.pending.delete(msg.commandId);
                p.resolve(msg);
                return;
            }
        }
        if (msg.type === "registered") {
            const key = `registered:${msg.vmId}:${msg.site}`;
            const p = this.pending.get(key);
            if (p) {
                this.pending.delete(key);
                p.resolve(msg);
                return;
            }
        }
        for (let i = this.waiters.length - 1; i >= 0; i--) {
            const w = this.waiters[i];
            if (w.match(msg)) {
                this.waiters.splice(i, 1);
                w.resolve(msg);
                return;
            }
        }
    }
    send(msg) {
        if (!this.child)
            throw new Error("executor not running");
        this.child.send(msg);
    }
    request(msg, key) {
        return new Promise((resolve, reject) => {
            this.pending.set(key, {
                resolve: (m) => resolve(m),
                reject,
            });
            this.send(msg);
        });
    }
    /** 等待执行器进入暂停点（测试用）。 */
    waitPaused(commandId) {
        return new Promise((resolve) => {
            this.waiters.push({
                match: (m) => m.type === "paused" && m.commandId === commandId,
                resolve: () => resolve(),
            });
        });
    }
    async register(vmId, site, state) {
        await this.request({ type: "register", vmId, site, state }, `registered:${vmId}:${site}`);
    }
    async exec(commandId, vmId, site, op) {
        const res = await this.request({ type: "exec", commandId, vmId, site, op }, commandId);
        return res.outcome;
    }
    async queryState() {
        const res = await new Promise((resolve) => {
            this.waiters.push({
                match: (m) => m.type === "state",
                resolve: (m) => resolve(m),
            });
            this.send({ type: "query" });
        });
        return res.replicas;
    }
    async history() {
        const res = await new Promise((resolve) => {
            this.waiters.push({
                match: (m) => m.type === "history",
                resolve: (m) => resolve(m),
            });
            this.send({ type: "history" });
        });
        return res.entries;
    }
    async armReject(commandId) {
        this.send({ type: "armReject", commandId });
        // armReject 需落盘后才安全；用一次 query 往返做屏障。
        await this.queryState();
    }
    async pauseAt(point, commandId) {
        this.send({ type: "pauseAt", point, commandId });
        await this.queryState();
    }
    async resume() {
        this.send({ type: "resume" });
    }
    /** 强杀执行器子进程（测试用）。 */
    async kill() {
        const child = this.child;
        if (!child)
            return;
        const exited = new Promise((resolve) => {
            child.once("exit", () => resolve());
        });
        child.kill("SIGKILL");
        await exited;
        this.child = null;
    }
    async shutdown() {
        const child = this.child;
        if (!child)
            return;
        const exited = new Promise((resolve) => {
            child.once("exit", () => resolve());
        });
        try {
            child.send({ type: "shutdown" });
        }
        catch {
            child.kill("SIGKILL");
        }
        await exited;
        this.child = null;
    }
}
//# sourceMappingURL=executorClient.js.map