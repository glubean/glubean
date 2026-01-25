# AI Instruction: Generate Glubean Runner Package

You are tasked with implementing the `@glubean/runner` package. This is the core execution engine that runs user tests in a secure Deno sandbox.

## Context
The Runner takes a user's test file (URL or path), loads it, and executes a specific test case. It captures all logs and assertions and streams them as structured JSON for the platform to consume.

## Requirements

1.  **Tech Stack:** Deno (TypeScript).
2.  **Location:** `packages/runner`
3.  **Security:** Must use Deno permissions (`--allow-net`, `--no-allow-read`) to sandbox user code.

## File Structure

```
packages/runner/
├── deno.json          # Package config (name: "@glubean/runner")
├── mod.ts             # Entry point exporting the Executor class
├── harness.ts         # The script running INSIDE the sandbox
└── executor.ts        # The logic spawning the sandbox process
```

## Implementation Details

### 1. `harness.ts` (The Sandbox)

This script is executed by `deno run`. It is the "bridge" between the Runner and User Code.

**Logic:**
1.  Parse CLI arguments: `--testUrl`, `--testId`, `--context` (JSON string).
2.  Dynamic Import: `const userModule = await import(testUrl)`.
3.  Find Test:
    *   Check for `testCase` export (simple case).
    *   Check for `testSuite` export. If found, find the specific test case within the suite.
4.  Execute Lifecycle (if Suite):
    *   Run `setup()` -> get `state`.
    *   Run `beforeEach()`.
    *   Run `testCase.fn(ctx, state)`.
    *   Run `afterEach()`.
    *   Run `teardown()`.
    *   *Note: For MVP, assume we run one test at a time, so we run full lifecycle for that single test.*
5.  Construct `TestContext`:
    *   `log(msg, data)`: `console.log(JSON.stringify({ type: 'log', message: msg, data }))`
    *   `assert(cond, msg, details)`: `console.log(JSON.stringify({ type: 'assertion', passed: cond, message: msg, actual: details?.actual, expected: details?.expected }))`
    *   `trace(req)`: `console.log(JSON.stringify({ type: 'trace', data: req }))`
6.  Handle Errors: Catch exceptions and print `{ type: 'error', ... }`.

### 2. `executor.ts` (The Manager)

This class manages the lifecycle of the sandbox process.

**Class `TestExecutor`:**
*   **Method `run(testUrl, testId, context)`:**
    *   Uses `new Deno.Command("deno", ...)` to spawn the harness.
    *   **Args:** `run`, `--allow-net`, `--no-check`, `harness.ts`, ...
    *   **Env:** Pass secrets via env vars or stdin (prefer stdin for security, but args for MVP).
    *   **Output:** Capture `stdout` pipe.
    *   **Parsing:** Read line-by-line, parse JSON, and yield events (Log, Assertion, Trace, Result).

### 3. `mod.ts`

Export `TestExecutor` and related types.

## Output
Generate the code for `deno.json`, `harness.ts`, `executor.ts`, and `mod.ts`. Ensure `harness.ts` handles dynamic imports correctly.
