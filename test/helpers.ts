import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHUNK_SIZE } from "../src";

export interface GeneratedFile {
  bytes: Buffer;
  size: number;
  sha256: string;
  chunks: Buffer[];
}

/** 生成确定性伪随机文件内容及其分块。 */
export function makeFile(size: number, seed: string): GeneratedFile {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  let block = 0;
  while (offset < size) {
    const fill = crypto.createHash("sha256").update(`${seed}:${block++}`).digest();
    const n = Math.min(fill.length, size - offset);
    fill.copy(bytes, offset, 0, n);
    offset += n;
  }
  const chunks: Buffer[] = [];
  for (let off = 0; off < size; off += CHUNK_SIZE) {
    chunks.push(bytes.subarray(off, Math.min(off + CHUNK_SIZE, size)));
  }
  return { bytes, size, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), chunks };
}

export function freshDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `crashlens-${label}-`));
}

export interface ChildResult {
  /** 进程退出码；被信号杀死时为 null。 */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** 以真实子进程运行 dist/test/children/<name>.js（不使用 sleep 赌时序）。 */
export function runChild(name: string, env: Record<string, string>): ChildResult {
  const script = path.join(__dirname, "children", `${name}.js`);
  const res = spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.error) throw res.error;
  return { code: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr };
}

/** 子进程应被 SIGKILL 杀死。 */
export function expectKilled(r: ChildResult): void {
  if (r.signal !== "SIGKILL") {
    throw new Error(`expected child to be SIGKILLed, got code=${r.code} signal=${r.signal}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  }
}

export function expectCleanExit(r: ChildResult): void {
  if (r.code !== 0) {
    throw new Error(`expected clean exit, got code=${r.code} signal=${r.signal}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  }
}

export function sha256Of(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
