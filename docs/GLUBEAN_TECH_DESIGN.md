# Glubean Technical Architecture: Deno-Based Serverless Runner

## 1. Overview

This document outlines the technical architecture for **Glubean**, a serverless test runner platform built on **Deno**.

The core requirement is to support the **Load > Execute > Collect State** pattern for untrusted user code in a secure, scalable way.

## 2. Architecture Components

```mermaid
graph TD
    User[Developer] -->|1. Push Code| CLI[Glubean CLI]
    CLI -->|2. Upload Source| Registry[Code Registry (S3)]

    Scheduler[Scheduler / API] -->|3. Trigger| Runner[Deno Runner Service]

    Runner -->|4. Load| Registry
    Runner -->|5. Execute| Sandbox[Deno Sandbox]

    Sandbox -->|6. Stream Events| Collector[Result Collector]
    Collect -->|7. Store| DB[Database]
    DB -->|8. View| Dashboard[Web Dashboard]
```

## 3. The "Load > Execute > Collect" Pattern Implementation

### Phase 1: Load (Dynamic Import)

Unlike Node.js/VM2 which requires bundling, Deno supports **Dynamic Imports** from URLs.

**Mechanism:**

1.  User uploads `tests/login.ts` to Registry (S3).
2.  Registry serves it at `https://registry.glubean.com/u/proj/tests/login.ts`.
3.  Runner starts a "Harness" script.
4.  Harness uses `await import(testUrl)` to load the user's code.

**Why it works:**

- **No Build Step:** Deno compiles TypeScript on the fly.
- **Caching:** Deno caches remote modules automatically.
- **Standard:** Uses standard ESM web standards.

### Phase 2: Execute (Secure Sandbox)

The execution happens inside a Deno subprocess with strict permission flags.

**The Harness Script (`harness.ts`):**
This is the "wrapper" code that Glubean runs. It imports the user's code and invokes it.

```typescript
// harness.ts
import { parse } from "https://deno.land/std/flags/mod.ts";

// 1. Parse Arguments (Context)
const args = parse(Deno.args);
const testUrl = args.testUrl;
const testId = args.testId;
const contextData = JSON.parse(args.context);

// 2. Dynamic Import (LOAD)
console.log(`[System] Loading ${testUrl}...`);
const userModule = await import(testUrl);
const testCase = userModule[testId];

if (!testCase) {
  console.error(
    JSON.stringify({ type: "error", message: "Test case not found" }),
  );
  Deno.exit(1);
}

// 3. Construct Context Object
const ctx = {
  vars: contextData.vars,
  secrets: contextData.secrets,
  log: (msg: string, data?: any) => {
    // Stream logs to stdout as JSON
    console.log(JSON.stringify({ type: "log", message: msg, data }));
  },
  report: (result: any) => {
    // Stream assertion results
    console.log(JSON.stringify({ type: "assertion", result }));
  },
};

// 4. Invoke User Function (EXECUTE)
try {
  await testCase.fn(ctx);
  console.log(JSON.stringify({ type: "status", status: "completed" }));
} catch (err) {
  console.log(
    JSON.stringify({ type: "status", status: "failed", error: err.message }),
  );
}
```

**The Execution Command:**

```bash
deno run \
  --allow-net=api.example.com \  # Whitelist network access
  --no-check \                   # Faster startup
  harness.ts \
  --testUrl="..." \
  --testId="loginTest" \
  --context='{...}'
```

### Phase 3: Collect State (Stream Processing)

The Runner Service (the parent process) captures `stdout` from the Deno subprocess.

**Mechanism:**

1.  Runner spawns `deno run`.
2.  Runner listens to `stdout` pipe.
3.  User code calls `ctx.log()` or `ctx.report()`.
4.  Harness prints JSON lines: `{"type": "assertion", "result": {...}}`.
5.  Runner parses JSON lines and pushes them to the Database/Websocket.

**Why it works:**

- **Real-time:** Users see logs as they happen.
- **Structured:** JSON output allows rich reporting.
- **Isolated:** User code cannot mess with the reporting pipeline (it just prints to stdout).

## 4. Security Analysis

| Threat                 | Mitigation                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **File System Access** | Deno defaults to NO file access. We do not pass `--allow-read` or `--allow-write`.               |
| **Environment Access** | Deno defaults to NO env access. We do not pass `--allow-env`. Secrets are passed via args/stdin. |
| **Network Scanning**   | We can restrict `--allow-net` to specific domains or allow all (user choice).                    |
| **Infinite Loops**     | Parent process sets a timeout on the subprocess.                                                 |
| **Memory Exhaustion**  | Container limits (Docker/K8s) or Deno V8 flags.                                                  |

## 5. Comparison: Node.js (VM2) vs Deno

| Feature            | Node.js + VM2 (Old)           | Deno (New)                         |
| ------------------ | ----------------------------- | ---------------------------------- |
| **Isolation**      | Patching Node (Fragile)       | V8 Isolate + Rust Sandbox (Robust) |
| **Input Format**   | UMD Bundle (Requires Build)   | TypeScript Source (No Build)       |
| **Module Loading** | Custom Implementation         | Native `import()`                  |
| **Context**        | Global Injection (`global.x`) | Argument Passing (`fn(ctx)`)       |
| **Maintenance**    | VM2 is deprecated             | Active, Enterprise-backed          |

## 6. Proof of Concept Code

### The SDK (`mod.ts`)

```typescript
export interface TestContext {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  log(msg: string, data?: any): void;
  report(result: { passed: boolean; message: string }): void;
}

export function testCase(
  meta: { id: string; tags?: string[] },
  fn: (ctx: TestContext) => Promise<void>,
) {
  return { meta, fn };
}
```

### The User Code (`login.ts`)

```typescript
import { testCase } from "https://deno.land/x/glubean/mod.ts";

export const login = testCase({ id: "login" }, async (ctx) => {
  ctx.log("Starting login...");
  const res = await fetch(ctx.vars.baseUrl);
  ctx.report({ passed: res.ok, message: "API is up" });
});
```

## 7. Conclusion

The Deno architecture perfectly meets the **Load > Execute > Collect** pattern:

1.  **Load:** Handled natively by Deno's URL imports.
2.  **Execute:** Handled securely by Deno's permission system.
3.  **Collect:** Handled by structured JSON streaming over stdout.

It simplifies the entire stack by removing the need for a bundler (Rollup/Webpack) and a complex sandbox library (VM2).
