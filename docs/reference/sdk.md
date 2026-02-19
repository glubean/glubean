# @glubean/sdk

The Glubean SDK provides the API for writing API tests. It is designed to be thin, stable, and AI-friendly.

## Design Goals

- **Contracts-first**: SDK stays thin; runners and UI consume a shared event schema.
- **Reproducibility**: Tests use `ctx.vars` and `ctx.secrets` as the only config path.
- **Outbound-only**: No SDK dependency on control-plane APIs.
- **Secrets safety**: Secrets are never logged in plaintext; SDK helpers enforce redaction.

## Core API

### `test()` — Define a test

Two modes: quick (simple function) and builder (multi-step with state).

**Quick mode:**

```ts
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const baseUrl = ctx.vars.require("BASE_URL");
  const res = await fetch(`${baseUrl}/health`);
  ctx.assert(res.ok, "health check passed");
});
```

**Builder mode (multi-step):**

```ts
import { test } from "@glubean/sdk";

export const loginFlow = test("login-flow")
  .meta({ tags: ["auth", "smoke"] })
  .setup(async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    return { baseUrl };
  })
  .step("Login", async (ctx, { baseUrl }) => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      body: JSON.stringify({ user: "demo", pass: "demo" }),
    });
    ctx.assert(res.ok, "login succeeded");
    const { token } = await res.json();
    return { baseUrl, token };
  })
  .step("Verify session", async (ctx, { baseUrl, token }) => {
    const res = await fetch(`${baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ctx.assert(res.ok, "session valid");
  })
  .build();
```

### `configure()` — Shared setup with HTTP client

```ts
import { configure } from "@glubean/sdk";

const { test } = configure({
  http: {
    baseUrl: (ctx) => ctx.vars.require("BASE_URL"),
    headers: (ctx) => ({
      Authorization: `Bearer ${ctx.secrets.require("API_KEY")}`,
    }),
  },
});

export const listUsers = test("list-users", async (ctx) => {
  const res = await ctx.http.get("/users");
  ctx.assert(res.ok, "Should return 200");
});
```

## TestContext

The `ctx` object is passed to every test function. Key methods:

| Method                                     | Description                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `ctx.vars.get(key)`                        | Get a variable from `.env`, falling back to system env                            |
| `ctx.vars.require(key)`                    | Get a required variable (throws if missing from both `.env` and system env)       |
| `ctx.secrets.get(key)`                     | Get a secret from `.env.secrets`, falling back to system env                      |
| `ctx.secrets.require(key)`                 | Get a required secret (throws if missing from both `.env.secrets` and system env) |
| `ctx.log(message, data?)`                  | Structured logging (persisted in results)                                         |
| `ctx.assert(condition, message, details?)` | Boolean or structured assertion                                                   |
| `ctx.expect(value)`                        | Fluent assertions (`.toEqual()`, `.toContain()`, etc.)                            |
| `ctx.trace(request)`                       | Manual HTTP request/response trace                                                |
| `ctx.metric(name, value, tags?)`           | Custom metric emission                                                            |
| `ctx.fail(message)`                        | Explicitly fail the test                                                          |
| `ctx.skip(reason?)`                        | Skip the test at runtime                                                          |
| `ctx.pollUntil(options, fn)`               | Poll until a condition is met or timeout                                          |
| `ctx.http`                                 | HTTP client (when using `configure()`)                                            |
| `ctx.graphql`                              | GraphQL client (when using `configure()`)                                         |

### Metric Data Safety

`ctx.metric()` is for numeric observability and dashboard dimensions. Treat metric
names and tags as non-secret metadata.

- Do not put tokens, API keys, emails, phone numbers, or user identifiers into
  metric names or tags.
- Prefer stable, low-cardinality tags such as `endpoint`, `method`, or `region`.

```ts
// Good
ctx.metric("http_duration_ms", duration, {
  unit: "ms",
  tags: { endpoint: "/orders", method: "GET" },
});

// Bad: sensitive value in tags
ctx.metric("auth_check", 1, {
  tags: { bearer: ctx.secrets.require("API_TOKEN") },
});
```

## Data-Driven Tests

See [Data Loading](../guides/data-loading.md) for CSV, YAML, JSON, and directory-based data loading.

## Assertions

See [Assertions](../guides/assertions.md) for the full assertion and validation reference.

## Events

Every SDK method emits structured events consumed by the runner and UI. See [Event Reference](events.md) for the full
event reference.
