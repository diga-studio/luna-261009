// 最小类型声明：避免测试编译依赖 @types/node，干净机器只需 typescript。
declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
}
