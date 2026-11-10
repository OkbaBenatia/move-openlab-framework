// Minimal declarations of the two Node built-ins the unit tests use (no @types/node dependency).
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  };
  export default assert;
}
