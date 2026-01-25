# AI Instruction: Generate Glubean SDK Package

You are tasked with implementing the `@glubean/sdk` package for the Glubean monorepo. This package provides the types and runtime helpers for users to write test cases.

## Context
Glubean is a serverless test runner. Users write test cases in TypeScript using this SDK. The tests are then executed by the `@glubean/runner` in a secure Deno sandbox.

## Requirements

1.  **Tech Stack:** Deno (TypeScript).
2.  **Location:** `packages/sdk`
3.  **No Dependencies:** This package should be lightweight and dependency-free if possible.

## File Structure

```
packages/sdk/
├── deno.json          # Package config (name: "@glubean/sdk", exports: "./mod.ts")
├── mod.ts             # Main entry point
└── types.ts           # Shared interfaces
```

## Implementation Details

### 1. `types.ts`

Define the core interfaces that contract the interaction between User Code and the Runner.

```typescript
// The context passed to every test function
export interface TestContext {
  // Environment variables (e.g. BASE_URL)
  vars: Record<string, string>;
  // Secrets (e.g. API_KEY) - injected securely
  secrets: Record<string, string>;
  
  // Logging function - streams to runner stdout
  // Example: ctx.log("User created", { id: 123 })
  log(message: string, data?: any): void;
  
  // Assertion reporting - streams to runner stdout
  // Overload 1: Simple boolean check
  // Example: ctx.assert(res.ok, "API should return 200")
  assert(condition: boolean, message?: string, details?: AssertionDetails): void;

  // Overload 2: Explicit result object (useful for complex logic)
  // Example: ctx.assert({ passed: res.status === 200, actual: res.status, expected: 200 }, "Status check")
  assert(result: AssertionResultInput, message?: string): void;
  
  // API Tracing - manually report network calls
  // Example: ctx.trace({ method: "GET", url: "...", status: 200, duration: 100 })
  trace(request: ApiTrace): void;
}

export interface AssertionDetails {
  actual?: any;
  expected?: any;
}

export interface AssertionResultInput {
  passed: boolean;
  actual?: any;
  expected?: any;
}

export interface ApiTrace {
  method: string;
  url: string;
  status: number;
  duration: number;
  requestHeaders?: Record<string, string>;
  requestBody?: any;
  responseHeaders?: Record<string, string>;
  responseBody?: any;
}

export interface AssertionResult {
  passed: boolean;
  message: string;
  actual?: any;
  expected?: any;
}

export interface TestCaseMeta {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  timeout?: number; // ms
}

export interface TestSuiteMeta {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}

export type TestFunction<S = any> = (ctx: TestContext, state: S) => Promise<void>;
export type SetupFunction<S = any> = (ctx: TestContext) => Promise<S>;
export type TeardownFunction<S = any> = (ctx: TestContext, state: S) => Promise<void>;
export type HookFunction<S = any> = (ctx: TestContext, state: S) => Promise<void>;

export interface TestCase<S = any> {
  meta: TestCaseMeta;
  fn: TestFunction<S>;
}

export interface TestSuite<S = any> {
  meta: TestSuiteMeta;
  setup?: SetupFunction<S>;
  teardown?: TeardownFunction<S>;
  beforeEach?: HookFunction<S>;
  afterEach?: HookFunction<S>;
  tests: TestCase<S>[];
}
```

### 2. `mod.ts`

Export the `testCase` and `testSuite` wrapper functions.

```typescript
import { TestCase, TestCaseMeta, TestFunction, TestSuite, TestSuiteMeta, SetupFunction, TeardownFunction, HookFunction } from "./types.ts";

/**
 * Define a Glubean test case.
 */
export function testCase<S = any>(meta: TestCaseMeta | string, fn: TestFunction<S>): TestCase<S> {
  const metadata = typeof meta === "string" ? { id: meta, name: meta } : meta;
  return { meta: metadata, fn };
}

/**
 * Define a Glubean test suite with lifecycle hooks.
 */
export function testSuite<S = any>(
  meta: TestSuiteMeta | string,
  config: {
    setup?: SetupFunction<S>;
    teardown?: TeardownFunction<S>;
    beforeEach?: HookFunction<S>;
    afterEach?: HookFunction<S>;
    tests: TestCase<S>[];
  }
): TestSuite<S> {
  const metadata = typeof meta === "string" ? { id: meta, name: meta } : meta;
  return {
    meta: metadata,
    setup: config.setup,
    teardown: config.teardown,
    beforeEach: config.beforeEach,
    afterEach: config.afterEach,
    tests: config.tests,
  };
}

// Re-export types for user convenience
export * from "./types.ts";
```

## Output
Generate the code for `deno.json`, `types.ts`, and `mod.ts`.
