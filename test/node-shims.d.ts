// 最小 Node 内置模块类型声明，避免依赖 @types/node。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(
    name: string,
    options: { timeout?: number },
    fn: () => void | Promise<void>,
  ): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export default assert;
}

declare const process: {
  hrtime: { bigint(): bigint };
};
