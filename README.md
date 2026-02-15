# Glubean — API collections, as real code.

Open-source, code-first API testing toolkit. Write TypeScript, click play, see every request and response.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@glubean/sdk`](packages/sdk/) | 0.5.1 | User-facing SDK — `test()`, `ctx.http`, assertions, structured logging |
| [`@glubean/runner`](packages/runner/) | 0.2.4 | Sandboxed test execution engine (Deno subprocess) |
| [`@glubean/cli`](packages/cli/) | 0.2.25 | CLI for running, scanning, and managing test projects |
| [`@glubean/scanner`](packages/scanner/) | 0.2.4 | Static analysis for test file discovery and metadata extraction |
| [`@glubean/redaction`](packages/redaction/) | 0.1.1 | Sensitive data redaction for logs and traces |
| [`@glubean/mcp`](packages/mcp/) | 0.1.2 | Model Context Protocol server for AI agent integration |
| [`@glubean/worker`](packages/worker/) | 0.1.8 | Cloud worker for remote test execution |

> **VS Code Extension** — The editor extension lives in [`packages/vscode`](packages/vscode/).
> Install from the Marketplace for inline play buttons, trace viewing, and diff.

## Install

```bash
# One-line install (macOS / Linux)
curl -fsSL https://glubean.com/install.sh | sh

# Or install directly if you have Deno
deno install -Agf jsr:@glubean/cli
```

## Quick Start

```bash
# Scaffold a new project (creates deno.json + demo files)
glubean init

# Run all tests
glubean run
```

## Writing Tests

### Simple test — one API call

```typescript
import { test } from "jsr:@glubean/sdk";

test("list products", async (ctx) => {
  const baseUrl = ctx.vars.require("BASE_URL");

  const data = await ctx.http
    .get(`${baseUrl}/products?limit=5`)
    .json<{ products: unknown[]; total: number }>();

  ctx.expect(data.products.length).toBe(5);
  ctx.expect(data.total).toBeGreaterThan(0);
  ctx.log(`Found ${data.total} products`);
});
```

### Multi-step test — chained with shared state

```typescript
import { test } from "jsr:@glubean/sdk";

export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const data = await ctx.http
      .post(`${baseUrl}/auth/login`, {
        json: {
          username: ctx.secrets.require("USERNAME"),
          password: ctx.secrets.require("PASSWORD"),
        },
      })
      .json<{ accessToken: string }>();

    ctx.expect(data.accessToken).toBeDefined();
    return { token: data.accessToken };
  })
  .step("get profile", async (ctx, { token }) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const profile = await ctx.http
      .get(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .json<{ email: string; firstName: string }>();

    ctx.expect(profile.email).toBeDefined();
    ctx.log(`Profile: ${profile.firstName} (${profile.email})`);
  });
```

### Data-driven test — run the same logic with different inputs

```typescript
import { test } from "jsr:@glubean/sdk";

export const userTests = test.each([
  { userId: 1 },
  { userId: 2 },
  { userId: 42 },
])("user-$userId")
  .step("fetch user", async (ctx, _state, { userId }) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(`${baseUrl}/users/${userId}`);
    ctx.assert(res.ok, `user ${userId} exists`);
    return { user: await res.json() };
  });
```

### Example-driven test — `test.pick`

```typescript
import { test } from "jsr:@glubean/sdk";

export const createUser = test.pick({
  normal:      { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
  admin:       { name: "Admin", role: "admin" },
})("create-user-$_pick", async (ctx, example) => {
  const baseUrl = ctx.vars.require("BASE_URL");
  const res = await ctx.http.post(`${baseUrl}/users`, { json: example });
  ctx.expect(res).toHaveStatus(201);
});
```

By default, `test.pick` randomly selects one example for lightweight fuzz
coverage. Run a specific example from the CLI with `--pick admin`, or click
individual CodeLens buttons in the VS Code extension.

### Key SDK APIs

| API | Description |
|-----|-------------|
| `ctx.http.get/post/put/delete(url, opts)` | Auto-traced HTTP client (records method, URL, headers, status, duration) |
| `ctx.vars.require("KEY")` | Read environment variable (from `.env`) |
| `ctx.secrets.require("KEY")` | Read secret (from `.env.secrets`, auto-redacted in output) |
| `ctx.expect(value).toBe(expected)` | Fluent assertion (soft-by-default, `.orFail()` for hard guard) |
| `ctx.assert(condition, message)` | Boolean assertion (low-level escape hatch) |
| `ctx.warn(condition, message)` | Soft check — records warning but never fails the test |
| `ctx.validate(data, schema, label)` | Schema validation (Zod, Valibot, or any `SchemaLike<T>`) |
| `ctx.log(message, data?)` | Structured log (persisted in results) |
| `ctx.metric(name, value, opts?)` | Numeric metric for dashboards and trending |
| `ctx.pollUntil(opts, fn)` | Retry a function until it returns truthy or times out |
| `test("id").step("name", fn)` | Multi-step builder with type-safe state passing |
| `test.each(table)("pattern")` | Data-driven test generation (one test per row) |
| `test.pick(examples)("pattern")` | Random example selection with CLI/CodeLens override |

## Project Structure

Directories organize your API collections. All test files use `*.test.ts` suffix — the directory determines grouping.

```
my-api-tests/
├── tests/                       ← permanent tests (CI, cloud)
│   ├── auth.test.ts             login, profile, refresh token
│   └── products.test.ts         list, search, pagination
├── explore/                     ← exploratory tests (IDE iteration)
│   └── new-endpoint.test.ts     try new endpoints, inspect responses
├── data/                        ← test data (JSON, YAML)
├── context/                     ← shared helpers and utilities
├── .env                         BASE_URL=https://api.example.com
├── .env.staging                 BASE_URL=https://staging.example.com
├── .env.secrets                 API_KEY=sk-...  (gitignored)
└── deno.json
```

- **`tests/`** — permanent tests that run in CI and cloud
- **`explore/`** — scratch pad for API exploration from VS Code with play buttons
- `glubean run` scans `tests/` by default; `glubean run --explore` scans `explore/`
- Move files from `explore/` → `tests/` when you're ready — zero migration effort

## Environment Files

Glubean uses a paired naming convention for variables and secrets:

| Environment | Variables | Secrets |
|-------------|-----------|---------|
| default     | `.env`    | `.env.secrets` |
| staging     | `.env.staging` | `.env.staging.secrets` |
| production  | `.env.prod` | `.env.prod.secrets` |

**Variables** (`.env`) — non-sensitive config: `BASE_URL`, `TIMEOUT_MS`, `API_VERSION`
**Secrets** (`.env.secrets`) — credentials: `API_KEY`, `PASSWORD`, `TOKEN`

```bash
# Use default .env + .env.secrets
glubean run tests/

# Use a specific environment
glubean run tests/ --env-file .env.staging
# → automatically loads .env.staging for vars, .env.staging.secrets for secrets
```

Both files use standard `KEY=VALUE` format. Secrets files should be in `.gitignore`.

## VS Code Extension

Install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=glubean.glubean), or build from source in [`packages/vscode`](packages/vscode/).

The extension handles setup automatically — if Deno or the CLI aren't installed,
it offers a one-click setup that installs everything silently in the background.

Key features: inline ▶ play buttons, Test Explorer sidebar, auto-traced
`.trace.jsonc` viewer, environment switcher, breakpoint debugging, diff with
previous run, copy as cURL, and `test.pick` CodeLens buttons.

## Architecture

This repository contains the **core runtime** — the SDK users write against and
the CLI/runner that executes tests. It sits in the middle of a three-layer
stack:

```
VS Code Extension (glubean/vscode)      ← editor UI, calls CLI
         │
         │  shell: glubean run file.ts --pick admin
         ▼
Core Runtime (this repo)                 ← SDK + CLI + runner
         │
         │  (optional) POST /api/runs
         ▼
Glubean Cloud (closed source)            ← dashboard, CI, collaboration
```

The extension depends only on the `glubean` system command — not on source code
in this repo. The Cloud consumes CLI output (result JSON, traces) via upload.

## CLI Commands

```bash
glubean init                           # Interactive project setup
glubean run                            # Run tests (defaults to tests/ directory)
glubean run --explore                  # Run explore files (explore/ directory)
glubean run path/to/file.test.ts       # Run a specific file
glubean run --verbose                  # Show all traces and assertions
glubean run --env-file .env.staging    # Use specific environment
glubean run --inspect-brk              # Debug with VS Code
glubean scan                           # Generate metadata.json
glubean diff --openapi spec.json       # Show API spec changes
glubean coverage --openapi spec.json   # API test coverage report
glubean context                        # Generate AI context file
glubean upgrade                        # Self-update CLI
```

## Development

```bash
# Format code
deno fmt

# Run linter
deno lint

# Run tests
deno test -A

# Run example tests
deno task example
```

## License

MIT
