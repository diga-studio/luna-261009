// 本组件只依赖 Node 内置测试运行器；此处给出所需 API 的最小类型声明，
// 避免引入 @types/node，保证干净机器上 npm install 只需 typescript。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
  export function throws(fn: () => void, message?: string): void;
}

declare function setImmediate(callback: (...args: unknown[]) => void): unknown;
