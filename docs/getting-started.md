# Getting Started

Get up and running with Glubean in 5 minutes.

## Install

```bash
deno install -A -n glubean jsr:@glubean/cli
```

## Initialize a Project

```bash
mkdir my-api-tests && cd my-api-tests
glubean init
```

This creates:

- `deno.json` with `@glubean/sdk` import map
- `.env` for environment variables
- `.env.secrets` for sensitive values (git-ignored)
- A sample test file

Configure your environment:

```env
# .env
BASE_URL=https://api.example.com
```

```env
# .env.secrets (never commit)
API_KEY=sk_live_xxxxxxx
```

## Write a Test

```typescript
import { test } from "@glubean/sdk";

export const listUsers = test(
  {
    id: "list-users",
    name: "List All Users",
    tags: ["users", "smoke"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    ctx.log("Fetching users...");
    const response = await fetch(`${baseUrl}/users`);
    const users = await response.json();

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(Array.isArray(users), "Should return array");
    ctx.assert(users.length > 0, "Should have users");

    ctx.log(`Found ${users.length} users`);
  },
);
```

## Run Tests

```bash
# Run all tests in a file
glubean run api.test.ts

# Run all tests in a directory
glubean run .

# Filter by tag, name, or id
glubean run api.test.ts --filter smoke

# Use a different env file
glubean run api.test.ts --env-file .env.staging
```

**Output:**

```
🧪 Glubean Test Runner

File: api.test.ts
Loaded 2 vars from .env

Running 1 test(s)...

  ● List All Users [users, smoke]
      Fetching users...
      Found 10 users
    ✓ PASSED (234ms)

─────────────────────────────────────
Tests: 1 passed
Total: 1
```

## CI / System Environment Variables

Glubean automatically falls back to system environment variables when a key is not found in `.env` or `.env.secrets`.
This means tests work in CI without generating env files.

**Priority chain:**

```
.env.secrets  >  .env  >  system environment
```

**GitHub Actions example:**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
      - run: deno install -A -n glubean jsr:@glubean/cli
      - run: glubean run .
        env:
          BASE_URL: https://api.staging.example.com
          API_KEY: ${{ secrets.API_KEY }}
```

No `.env` file needed — `ctx.vars.require("BASE_URL")` and `ctx.secrets.require("API_KEY")` resolve from the process
environment.

Locally, `.env` files still take precedence, so nothing changes for development.

## Import Convention

Always import from the `@glubean/sdk` alias defined in your `deno.json`, not from a hardcoded JSR URL:

```typescript
// ✅ Correct
import { test } from "@glubean/sdk";

// ❌ Wrong — breaks tooling features
import { test } from "jsr:@glubean/sdk@^0.11.0";
```

The `deno.json` import map handles version resolution. Using the alias ensures your test code works correctly with
Glubean tooling (scanner, trace grouping, VS Code extension).

## Next Steps

- [Assertions & Validation](guides/assertions.md) — `ctx.expect`, `ctx.assert`, `ctx.warn`, schema validation
- [Data-Driven Tests](guides/data-loading.md) — CSV, YAML, JSON, directory-based test data
- [AI Agent / MCP](guides/mcp.md) — Set up the MCP server for Cursor
- [Releasing Packages](guides/releasing.md) — Version bumping, cross-repo coordination, template maintenance
- [SDK Reference](reference/sdk.md) — Full API reference
- [Event Reference](reference/events.md) — Runner event types
