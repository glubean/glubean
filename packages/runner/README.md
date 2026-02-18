# @glubean/runner

Sandboxed test execution engine for Glubean. Runs tests in isolated Deno subprocesses with HTTP interception, structured
event streaming, and debug support.

## Installation

```typescript
import { TestExecutor } from "jsr:@glubean/runner";
```

## Overview

The runner is the core execution layer between the CLI/Extension and the SDK. It:

- Spawns each test file in an isolated Deno subprocess (sandbox)
- Intercepts and traces HTTP requests via the SDK's `ctx.trace()` / `ctx.http` APIs
- Streams structured events (logs, assertions, traces, metrics) back to the caller
- Supports V8 Inspector debugging (`--inspect-brk`)
- Handles timeouts, retries, and graceful cancellation

## Usage

```typescript
import { TestExecutor } from "@glubean/runner";

const executor = new TestExecutor({
  permissions: ["net", "env", "read"],
});

// Run a single test file
const result = await executor.run("./tests/api.test.ts", {
  envVars: { BASE_URL: "https://api.example.com" },
  verbose: true,
  onEvent: (event) => {
    console.log(event.type, event.data);
  },
});

console.log(result.success ? "PASS" : "FAIL");

// Run multiple files
const batch = await executor.executeMany([
  "./tests/auth.test.ts",
  "./tests/users.test.ts",
], {
  envVars: { BASE_URL: "https://api.example.com" },
});

console.log(`${batch.passed}/${batch.total} passed`);
```

## Event Types

The runner emits structured `ExecutionEvent` objects:

| Type                      | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `log`                     | `ctx.log()` output                             |
| `assertion`               | `ctx.assert()` / `ctx.expect()` results        |
| `trace`                   | HTTP request/response pairs from `ctx.trace()` |
| `metric`                  | Performance metrics from `ctx.metric()`        |
| `warning`                 | `ctx.warn()` messages                          |
| `step:start` / `step:end` | Multi-step test boundaries                     |
| `error`                   | Unhandled errors                               |

## Architecture

```
CLI / Extension
      ↓
  TestExecutor
      ↓
  Deno subprocess (harness.ts)
      ↓
  SDK (test functions + TestContext)
```

The harness runs inside the subprocess, imports the test file, executes tests, and communicates results back to the
executor via structured JSON on stdout.

## License

MIT
