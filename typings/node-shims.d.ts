// 本项目对 Node 内置模块使用的最小类型声明，避免依赖 @types/node。
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }
}
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function before(fn: () => void): void;
  export function after(fn: () => void): void;
}
declare module 'node:assert/strict' {
  export function ok(value: any, message?: string): void;
  export function equal(a: any, b: any, message?: string): void;
  export function notEqual(a: any, b: any, message?: string): void;
  export function deepEqual(a: any, b: any, message?: string): void;
  export function throws(fn: () => void, error?: any, message?: string): void;
  export function doesNotThrow(fn: () => void, message?: string): void;
  export function match(s: string, re: RegExp, message?: string): void;
}
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:crypto' {
  export function randomUUID(): string;
}
