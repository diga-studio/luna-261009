/**
 * 子进程：建立批次并按指定顺序提交分块，在第 KILL_AFTER 个分块持久化后自杀（SIGKILL）。
 * 环境变量：DIR, UPLOAD_KEY, TICKET_ID, SIZES（逗号分隔）, SEED, ORDER（"fi:ci,fi:ci..."）, KILL_AFTER
 */
import { CrashLensStore } from "../../src";
import { makeFile } from "../helpers";

const dir = must("DIR");
const uploadKey = must("UPLOAD_KEY");
const ticketId = must("TICKET_ID");
const sizes = must("SIZES").split(",").map(Number);
const seed = must("SEED");
const order = must("ORDER")
  .split(",")
  .map((p) => p.split(":").map(Number) as [number, number]);
const killAfter = Number(must("KILL_AFTER"));

const files = sizes.map((size, i) => makeFile(size, `${seed}:${i}`));

let persisted = 0;
const store = new CrashLensStore(dir, {
  afterChunkPersist: () => {
    persisted += 1;
    if (persisted >= killAfter) {
      // 真实崩溃：不关闭存储、不清理，直接自杀。
      process.kill(process.pid, "SIGKILL");
    }
  },
});
store.begin(
  uploadKey,
  ticketId,
  files.map((f) => ({ size: f.size, sha256: f.sha256 })),
);
for (const [fi, ci] of order) {
  store.putChunk(uploadKey, fi, ci, Buffer.from(files[fi].chunks[ci]));
}
console.log("child finished without kill");

function must(name: string): string {
  const v = process.env[name];
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}
