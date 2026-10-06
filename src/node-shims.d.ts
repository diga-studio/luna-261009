// 最小化 Node 内置模块类型声明，使本库不依赖 @types/node 即可编译。
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, ...args: unknown[]): void;
    skip(name: string, ...args: unknown[]): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, message?: string): void;
  };
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
};

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:perf_hooks" {
  export const performance: { now(): number };
}
