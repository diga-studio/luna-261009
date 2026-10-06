/**
 * 子进程：建立批次、提交全部分块，然后在指定 Commit 暂停点自杀（SIGKILL）。
 * 环境变量：DIR, UPLOAD_KEY, TICKET_ID, SIZES（逗号分隔）, SEED, KILL_POINT
 *   KILL_POINT ∈ afterFilePersistBeforePublish | afterPublishBeforeReturn
 */
import { CrashLensStore, CrashHooks } from "../../src";
import { makeFile } from "../helpers";

const dir = must("DIR");
const uploadKey = must("UPLOAD_KEY");
const ticketId = must("TICKET_ID");
const sizes = must("SIZES").split(",").map(Number);
const seed = must("SEED");
const killPoint = must("KILL_POINT") as keyof CrashHooks;

const files = sizes.map((size, i) => makeFile(size, `${seed}:${i}`));

const kill = () => process.kill(process.pid, "SIGKILL");
const hooks: CrashHooks = {};
if (killPoint === "afterFilePersistBeforePublish") hooks.afterFilePersistBeforePublish = kill;
else if (killPoint === "afterPublishBeforeReturn") hooks.afterPublishBeforeReturn = kill;
else throw new Error(`unknown KILL_POINT ${killPoint}`);

const store = new CrashLensStore(dir, hooks);
store.begin(
  uploadKey,
  ticketId,
  files.map((f) => ({ size: f.size, sha256: f.sha256 })),
);
for (let fi = 0; fi < files.length; fi++) {
  for (let ci = 0; ci < files[fi].chunks.length; ci++) {
    store.putChunk(uploadKey, fi, ci, Buffer.from(files[fi].chunks[ci]));
  }
}
store.commit(uploadKey);
console.log("child finished without kill");

function must(name: string): string {
  const v = process.env[name];
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}
