// Minimal type declarations for the Node.js built-in modules used by the
// tests. Declared locally so the project builds without @types/node.
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
    (name: string, options: { timeout?: number }, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => void, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
