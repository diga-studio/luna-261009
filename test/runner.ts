import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkerRunResult {
  lines: string[];
  stderr: string;
  signal: string | null;
  code: number | null;
}

export interface KillSpec {
  /** 看到该行（前缀匹配）后触发 SIGKILL；"TIMER" 表示启动后 delayMs 即杀；null 表示不杀 */
  trigger: string | null;
  /** 触发后额外等待的毫秒数（让操作进行到中段的概率更高） */
  delayMs?: number;
}

const WORKER_PATH = path.join(__dirname, "child", "worker.js");

/** 启动 worker 执行脚本；按 KillSpec 在指定输出行处 SIGKILL。 */
export function runWorker(script: unknown, kill: KillSpec): Promise<WorkerRunResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "worker-script-")),
      "script.json"
    );
    fs.writeFileSync(scriptPath, JSON.stringify(script));
    const child = spawn(process.execPath, [WORKER_PATH, scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let stderr = "";
    let buffer = "";
    let killed = false;
    const delayMs = kill.delayMs ?? 0;
    if (kill.trigger === "TIMER") {
      killed = true;
      setTimeout(() => {
        child.kill("SIGKILL");
      }, delayMs);
    }

    const maybeKill = (): void => {
      if (killed || kill.trigger === null) {
        return;
      }
      if (lines.some((l) => l.startsWith(kill.trigger as string))) {
        killed = true;
        setTimeout(() => {
          child.kill("SIGKILL");
        }, delayMs);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      maybeKill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
      resolve({ lines, stderr, signal, code });
    });
  });
}
