// 最小 Node 环境声明，避免引入 @types/node 依赖。
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: (string | number | null)[]): { changes: number; lastInsertRowid: number };
    get(...params: (string | number | null)[]): Record<string, unknown> | undefined;
    all(...params: (string | number | null)[]): Record<string, unknown>[];
    iterate(...params: (string | number | null)[]): IterableIterator<Record<string, unknown>>;
  }
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, opts: { timeout?: number }, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, msg?: string): void;
}

declare const process: {
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  env: Record<string, string | undefined>;
};

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
