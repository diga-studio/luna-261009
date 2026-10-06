// 子进程 worker：按脚本执行上传操作，每步前后打印 pre/ack 行，
// 父进程可在任意输出行处 SIGKILL，模拟进程在任意时刻被强制终止。
import * as fs from "node:fs";
import { UploadStore } from "../../src/index";

interface Op {
  op: "begin" | "submit" | "complete" | "progress";
  sessionId: string;
  totalBytes?: number;
  sha256?: string;
  index?: number;
  dataFile?: string;
}

interface Script {
  dir: string;
  ops: Op[];
  stepDelayMs: number;
  holdBeforeExitMs?: number;
}

function line(s: string): void {
  process.stdout.write(s + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const scriptPath = process.argv[2];
  if (scriptPath === undefined) {
    throw new Error("usage: worker <script.json>");
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf8")) as Script;
  const store = new UploadStore(script.dir);
  line("ready");
  for (let i = 0; i < script.ops.length; i += 1) {
    const op = script.ops[i] as Op;
    await sleep(script.stepDelayMs);
    line(`pre ${i} ${op.op}`);
    switch (op.op) {
      case "begin":
        store.begin(op.sessionId, op.totalBytes as number, op.sha256 as string);
        line(`ack ${i} begin`);
        break;
      case "submit": {
        const data = fs.readFileSync(op.dataFile as string);
        store.submitChunk(op.sessionId, op.index as number, data);
        line(`ack ${i} submit ${op.index}`);
        break;
      }
      case "complete": {
        const ref = store.complete(op.sessionId);
        line(`ack ${i} complete ${ref.path}`);
        break;
      }
      case "progress": {
        const p = store.progress(op.sessionId);
        line(`ack ${i} progress ${JSON.stringify(p)}`);
        break;
      }
    }
  }
  await sleep(script.holdBeforeExitMs ?? 0);
  line("done");
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
