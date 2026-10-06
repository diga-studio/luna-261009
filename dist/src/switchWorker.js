/**
 * 测试辅助：在独立子进程中执行一次 SwitchGroup。
 * 测试可对该进程 SIGKILL，模拟编排方在任意时刻被终止。
 *
 * 用法: node switchWorker.js <orchDb> <execDb> <groupId> <requestId>
 * stdout: 启动后打印 executor 子进程 pid（JSON 行），
 *         完成后打印 {"result": ...}。
 */
import { ExecutorClient } from "./executorClient.js";
import { Orchestrator } from "./orchestrator.js";
async function main() {
    const [orchDb, execDb, groupId, requestId] = process.argv.slice(2);
    if (!orchDb || !execDb || !groupId || !requestId) {
        throw new Error("usage: switchWorker.js <orchDb> <execDb> <groupId> <requestId>");
    }
    const executor = new ExecutorClient({ dbPath: execDb });
    await executor.start();
    const orchestrator = new Orchestrator({ dbPath: orchDb, executor });
    const result = await orchestrator.switchGroup(groupId, requestId);
    console.log(JSON.stringify({ result }));
    orchestrator.close();
    await executor.shutdown();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=switchWorker.js.map