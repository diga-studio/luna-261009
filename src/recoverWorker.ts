/**
 * 测试辅助：在独立子进程中执行 Recover()。
 * 用法: node recoverWorker.js <orchDb> <execDb>
 */
import { ExecutorClient } from "./executorClient.js";
import { Orchestrator } from "./orchestrator.js";

async function main(): Promise<void> {
  const [orchDb, execDb] = process.argv.slice(2);
  if (!orchDb || !execDb) {
    throw new Error("usage: recoverWorker.js <orchDb> <execDb>");
  }
  const executor = new ExecutorClient({ dbPath: execDb });
  await executor.start();
  const orchestrator = new Orchestrator({ dbPath: orchDb, executor });
  await orchestrator.recover();
  console.log(JSON.stringify({ recovered: true }));
  orchestrator.close();
  await executor.shutdown();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
