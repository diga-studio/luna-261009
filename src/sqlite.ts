// 通过 createRequire 加载 node:sqlite，并给出本库需要的最小接口。
// 这样无论本机 @types/node 版本新旧（是否包含 node:sqlite 类型）都能编译。
import { createRequire } from "node:module";

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const req = createRequire(__filename);

export function openDatabase(path: string): SqliteDatabase {
  const mod = req("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDatabase };
  return new mod.DatabaseSync(path);
}
