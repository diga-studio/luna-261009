declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
