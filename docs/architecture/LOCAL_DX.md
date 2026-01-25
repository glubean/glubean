# Local Development Experience

The "Inner Loop" of development—write, run, debug—is where developers spend 90% of their time. Glubean must make this fast, predictable, and frictionless.

**Local running is the recommended default** for development. Cloud execution is reserved for scheduled jobs and production monitoring.

## Why Local Run?

| Benefit | Description |
|---------|-------------|
| **Access localhost** | Test against local dev servers, databases, internal APIs |
| **No queue** | Instant execution, fast feedback loop |
| **Zero cost** | Uses your machine, no cloud compute charges |
| **Debugging** | Full IDE debugging support with `--debug` flag |

## The Workflow

### Option A: Run local files directly

1.  **Write Code:** User edits `auth/login.ts` in VS Code.
2.  **Run Test:** User runs `glubean run auth/login.ts`.
3.  **View Result:** Terminal shows logs, assertions, and pass/fail status.
4.  **Debug:** User adds `ctx.log()`, re-runs.

### Option B: Run a synced bundle from cloud

1.  **Sync to Cloud:** User syncs code via `glubean sync` or Git push.
2.  **Copy Command:** User copies CLI command from Bundle detail page in dashboard.
3.  **Run Locally:** User runs `glubean run bnd_abc123` (downloads and executes).
4.  **Iterate:** Same fast feedback loop, but using the exact bundle that would run in cloud.

## Design Principles

1.  **Parity:** Local execution logic MUST be identical to Cloud execution logic.
    *   *Implementation:* The CLI imports the exact same `@glubean/runner` package that the Cloud Worker uses.
2.  **Zero Config:** It should "just work" without complex setup.
    *   *Implementation:* Deno handles dependencies. No `npm install`.
3.  **Fast Feedback:** Sub-second startup time.
    *   *Implementation:* Deno is fast. No build step.

## How It Works (Under the Hood)

When user runs `glubean run ./test.ts`:

1.  **Environment Loading:**
    *   CLI looks for `.env` file in current directory.
    *   CLI looks for `.env.secrets` (optional, for local secrets).
    *   These are loaded into memory as the "Context".
2.  **Discovery:**
    *   CLI dynamically imports `./test.ts`.
    *   It scans exports for `testCase` objects.
3.  **Execution:**
    *   CLI spawns a child Deno process (the "Harness").
    *   It passes the Context (env vars) to the harness.
    *   Harness runs the test function.
4.  **Reporting:**
    *   Harness streams JSON events to stdout.
    *   CLI parses JSON and pretty-prints to terminal (Green checkmarks, Red crosses).

## Filtering & Selection

A robust runner needs to run specific tests.

### 1. Run All
```bash
# Recursively finds all **/*.test.ts (or configured pattern)
glubean run .
```

### 2. Filter by Name (`--filter`)
```bash
# Runs tests where id or name contains "login"
glubean run . --filter="login"
```

### 3. Filter by Tag (`--tags`)
```bash
# Runs tests with "smoke" tag
glubean run . --tags="smoke"

# Runs tests with "smoke" AND "auth" tags
glubean run . --tags="smoke,auth"
```

### 4. Run Only (`.only`)
Support for focused debugging in code:

```typescript
// Only this test will run in the file
export const debugTest = testCase({ id: "debug", only: true }, ...);
```

## Potential Issues & "Bad UX" Traps

### 1. The "Missing Secrets" Problem
*   **Issue:** Cloud has `STRIPE_KEY` in KMS. Local dev doesn't have it. Test fails locally.
*   **Bad UX:** "Error: undefined is not an object."
*   **Solution:**
    *   CLI should warn: "Warning: $secrets.STRIPE_KEY is accessed but not defined."
    *   **Feature:** `glubean env pull` command to download non-sensitive vars from cloud.
    *   **Feature:** `glubean run --remote-secrets` (Pro) to fetch temp secrets from cloud (requires login).

### 2. The "Private Network" Problem
*   **Issue:** Test tries to hit `localhost:3000` (local API).
*   **Cloud:** Fails (Cloud can't see localhost).
*   **Local:** Works.
*   **Confusion:** "It works on my machine but fails in CI."
*   **Solution:** Clear documentation that Cloud Runner needs public URLs. Or build a Tunnel feature (`glubean tunnel`).

### 3. The "Dependency Divergence"
*   **Issue:** User has `deno v1.30` locally, Cloud has `v1.40`.
*   **Bad UX:** Syntax error in cloud but not locally.
*   **Solution:** Pin Deno version in `glubean.json` config. CLI warns if local version mismatch.

### 4. The "Console Log" Noise
*   **Issue:** User uses `console.log` instead of `ctx.log`.
*   **Bad UX:** Logs appear in terminal but are NOT captured in the JSON stream, so they don't show up in Cloud Dashboard history.
*   **Solution:** The Harness should intercept `console.log` and wrap it in a JSON event automatically.

### 5. Debugging Experience
*   **Issue:** `console.log` debugging is primitive.
*   **Better UX:** Support `--inspect` flag.
    *   `glubean run --debug test.ts` -> Starts Deno with `--inspect-brk`.
    *   User attaches VS Code Debugger.
    *   **This is a huge advantage over SaaS-only runners.**

## Running Bundles from Cloud

When a bundle is synced to Glubean cloud, you can run it locally:

```bash
# Download and run a bundle by ID
glubean run bnd_abc123def456

# With environment variables from a cloud env group
glubean run bnd_abc123 --env staging

# With local secrets (from .env.secrets in project root)
glubean run bnd_abc123 --local-secrets

# Filter specific tests
glubean run bnd_abc123 --filter "login"
```

**How it works:**

1. CLI checks login status (prompts `glubean login` if needed)
2. Downloads bundle tarball from cloud (cached in `~/.glubean/bundles/`)
3. Fetches env vars from cloud env group (secrets NOT included for security)
4. Loads local secrets from `.env.secrets` if `--local-secrets` flag is set
5. Executes using `@glubean/runner` with pretty terminal output

**Benefits over cloud execution:**

- Access `localhost:3000` and internal networks
- No queue wait time
- Zero cloud cost
- Full debugging support

## Summary

The local experience is the **primary differentiator** against tools like Postman (where local running is an afterthought) or pure SaaS runners (where you can't run locally at all).

By sharing the `@glubean/runner` package, we ensure that "It works on my machine" actually means "It works in production."

**Product strategy:** Encourage local runs for development (90%+ of usage), reserve cloud execution for scheduled jobs and production monitoring.
