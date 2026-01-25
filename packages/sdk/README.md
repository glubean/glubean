# @glubean/sdk

The official SDK for writing Glubean verification tests. Write API tests that run locally and in the cloud with zero configuration changes.

## Installation

```bash
# Using Deno
deno add jsr:@glubean/sdk

# Or import directly
import { test } from "jsr:@glubean/sdk";
```

### For Scanner/Tooling Only

If you're building tools that need to scan test metadata (like the Glubean scanner), use the internal API:

```typescript
// ⚠️ Internal API - not for test code
import { getRegistry } from "jsr:@glubean/sdk/internal";
```

**Note**: The internal API is not part of the public contract and may change without notice.

## Quick Start

```typescript
import { test } from "@glubean/sdk";

// Simple test - just export it
export const healthCheck = test("health-check", async (ctx) => {
  const res = await fetch(ctx.vars.require("BASE_URL") + "/health");
  ctx.assert(res.ok, "API should be healthy");
});
```

Run locally:

```bash
glubean run ./api.test.ts
```

Output includes automatic memory profiling:

```
  ● health-check
    ✓ PASSED (123ms, 8.5 MB)
```

## Test API

```typescript
import { test } from "@glubean/sdk";

// Quick mode - single function
export const login = test("login", async (ctx) => {
  const res = await fetch(ctx.vars.require("BASE_URL") + "/login");
  ctx.assert(res.ok, "Login should succeed");
});

// Builder mode - multi-step with lifecycle
export const checkout = test<{ cartId: string }>("checkout-flow")
  .meta({ tags: ["e2e", "critical"] })
  .setup(async (ctx) => {
    const cart = await createCart(ctx.vars.require("API_KEY"));
    return { cartId: cart.id };
  })
  .step("Add item", async (ctx, state) => {
    await addItem(state.cartId, "product-123");
    return state;
  })
  .step("Apply discount", async (ctx, state) => {
    await applyDiscount(state.cartId, "SAVE10");
    return state;
  })
  .step("Complete checkout", async (ctx, state) => {
    const order = await checkout(state.cartId);
    ctx.assert(order.status === "completed", "Order should complete");
  })
  .teardown(async (ctx, state) => {
    await deleteCart(state.cartId);
  });
```

## Features

### Test Context (`ctx`)

Every test function receives a `TestContext` with these capabilities:

#### Environment Variables

```typescript
// Safe access with explicit error handling
const baseUrl = ctx.vars.require("BASE_URL"); // Throws if missing
const region = ctx.vars.get("REGION") ?? "us-east-1"; // Optional with default
const allVars = ctx.vars.all(); // Get all vars (for debugging)

// With validation (boolean)
const port = ctx.vars.require("PORT", (v) => !isNaN(Number(v)));

// With custom error message
const apiKey = ctx.vars.require("API_KEY", (v) =>
  v.length >= 32 ? true : `must be at least 32 chars, got ${v.length}`
);
```

#### Secrets

```typescript
// Safe access - same API as vars
const apiKey = ctx.secrets.require("API_KEY"); // Throws if missing
const optionalToken = ctx.secrets.get("REFRESH_TOKEN"); // Optional

// With validation
const jwt = ctx.secrets.require("JWT_TOKEN", (v) => {
  const parts = v.split(".");
  if (parts.length !== 3) return "must be a valid JWT (3 parts)";
});
```

#### Logging

```typescript
// Logs are streamed to the runner and dashboard
ctx.log("User created", { id: 123, email: "test@example.com" });
ctx.log("Processing order...");
```

#### Assertions

```typescript
// Simple boolean assertion
ctx.assert(res.ok, "Request should succeed");

// With actual/expected values (shown in reports)
ctx.assert(res.status === 200, "Status check", {
  actual: res.status,
  expected: 200,
});

// Explicit result object
ctx.assert(
  {
    passed: data.items.length > 0,
    actual: data.items.length,
    expected: "> 0",
  },
  "Should have items"
);
```

#### API Tracing

```typescript
// Manual tracing for custom HTTP clients
const start = Date.now();
const res = await myClient.get("/users");
ctx.trace({
  method: "GET",
  url: "/users",
  status: res.status,
  duration: Date.now() - start,
  responseBody: res.data,
});
```

#### Dynamic Test Control

```typescript
// Skip test based on conditions
if (!ctx.vars.get("FEATURE_ENABLED")) {
  ctx.skip("Feature not enabled in this environment");
}

// Set timeout dynamically
const isProd = ctx.vars.get("ENV") === "production";
ctx.setTimeout(isProd ? 30000 : 10000);

// Check retry count
if (ctx.retryCount > 0) {
  ctx.log(`Retry attempt ${ctx.retryCount}`);
}
```

#### Memory Profiling

```typescript
// Check memory usage at any point
const mem = ctx.getMemoryUsage();
if (mem) {
  ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
}

// Track memory delta
const before = ctx.getMemoryUsage();
await loadLargeDataset();
const after = ctx.getMemoryUsage();
if (before && after) {
  const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  ctx.log(`Memory used: ${delta.toFixed(2)} MB`);
}
```

See [Memory Profiling Guide](../../docs/MEMORY_PROFILING.md) for detailed examples.

### Test Metadata

Both APIs support rich metadata:

```typescript
// Builder API
export const myTest = test({
  id: "my-test",
  name: "My Test",
  description: "Tests the login flow",
  tags: ["auth", "smoke", "critical"],
  timeout: 60000,  // 60 seconds
  skip: false,     // Set to true to skip
  only: false,     // Set to true to run only this test
}, async (ctx) => { ... });

```

### Step Options

For builder mode, each step can have its own configuration:

```typescript
export const resilientTest = test("resilient").step(
  "Flaky API call",
  { retries: 3, timeout: 10000 },
  async (ctx, state) => {
    // This step will retry up to 3 times on failure
    const res = await fetch("/flaky-endpoint");
    ctx.assert(res.ok, "Should eventually succeed");
  }
);
```

### Type-Safe State

State flows through your test with full TypeScript support:

```typescript
interface TestState {
  userId: string;
  sessionToken: string;
  orderId?: string;
}

export const orderFlow = test<TestState>("order-flow")
  .setup(async (ctx) => {
    const user = await createUser();
    const session = await login(user);
    return {
      userId: user.id,
      sessionToken: session.token,
    };
  })
  .step("Create order", async (ctx, state) => {
    const order = await createOrder(state.sessionToken);
    return { ...state, orderId: order.id }; // Type-safe state update
  })
  .step("Verify order", async (ctx, state) => {
    // TypeScript knows state.orderId might be undefined here
    // But after the previous step, it's guaranteed to exist
    ctx.assert(state.orderId, "Order should exist");
  })
  .teardown(async (ctx, state) => {
    if (state.orderId) await deleteOrder(state.orderId);
    await deleteUser(state.userId);
  });
```

### Step Composition (`.use()` / `.group()`)

Reusable step sequences are just plain functions. No new abstractions needed.

#### `.use()` — Apply a builder transform

```typescript
// Define reusable steps as a plain function
const withAuth = (b: TestBuilder<unknown>) => b
  .step("login", async (ctx) => {
    const data = await ctx.http.post("/auth/login", { json: creds }).json<{ token: string }>();
    return { token: data.token };
  })
  .step("verify token", async (ctx, { token }) => {
    const me = await ctx.http.get("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    }).json<{ id: string }>();
    return { token, userId: me.id };
  });

// Reuse across tests
export const testA = test("test-a")
  .use(withAuth)
  .step("create order", async (ctx, { token, userId }) => { /* ... */ });

export const testB = test("test-b")
  .use(withAuth)
  .step("update profile", async (ctx, { token, userId }) => { /* ... */ });
```

#### `.group()` — Same as `.use()` with report grouping

Steps added inside `.group()` are tagged with a group ID for visual grouping in reports:

```typescript
export const checkout = test("checkout")
  .group("auth", withAuth)
  .group("cart", withCart)
  .step("pay", async (ctx, { token, cartId }) => { /* ... */ });

// Report output:
// checkout
//   ├─ [auth]
//   │   ├─ login ✓
//   │   └─ verify token ✓
//   ├─ [cart]
//   │   └─ add to cart ✓
//   └─ pay ✓
```

You can also use `.group()` inline for organization without reuse:

```typescript
export const e2e = test("e2e")
  .group("setup", b => b
    .step("seed database", async (ctx) => ({ dbId: "..." }))
    .step("create user", async (ctx, { dbId }) => ({ dbId, userId: "..." }))
  )
  .step("verify", async (ctx, { dbId, userId }) => { /* ... */ });
```

Both `.use()` and `.group()` are also available on `EachBuilder` for data-driven tests.

### GraphQL Client ⚠️ Experimental

> **Note**: This feature is experimental and may change in future minor releases.

The SDK includes a built-in GraphQL client that wraps `ctx.http` with
GraphQL-specific conveniences: operation name extraction, auto-tracing per
operation, and optional error-throwing.

Every GraphQL request is auto-traced. The operation name (e.g., `GetUser`,
`CreateOrder`) is injected into traces so the dashboard can distinguish between
different operations instead of showing generic `POST /graphql`.

#### Using `.gql` files (recommended)

For full IDE support (syntax highlighting, field autocomplete, schema validation),
write queries in `.gql` files and load them with `fromGql`:

```graphql
# queries/getUser.gql
query GetUser($id: ID!) {
  user(id: $id) {
    name
    email
  }
}
```

```typescript
import { test, configure, fromGql } from "@glubean/sdk";

const GetUser = await fromGql("./queries/getUser.gql");
const CreateOrder = await fromGql("./queries/createOrder.gql");

const { graphql } = configure({
  graphql: {
    endpoint: "graphql_url",
    headers: { Authorization: "Bearer {{api_key}}" },
  },
});

export const getUser = test("get-user", async (ctx) => {
  const { data } = await graphql.query<{ user: { name: string } }>(
    GetUser, { variables: { id: "1" } }
  );
  ctx.expect(data?.user.name).toBe("Alice");
});
```

> **Tip**: Add a `.graphqlrc.yml` pointing to your schema for autocomplete
> and validation inside `.gql` files:
>
> ```yaml
> schema: https://api.example.com/graphql
> documents: "queries/**/*.gql"
> ```

#### With inline queries

For quick, one-off queries where a separate file would be overkill, use the
`gql` tagged template. The VSCode GraphQL extension recognizes the `gql` tag
and provides syntax highlighting:

```typescript
import { test, configure } from "@glubean/sdk";
import { gql } from "@glubean/sdk/graphql";

const { graphql } = configure({
  graphql: {
    endpoint: "graphql_url",
    headers: { Authorization: "Bearer {{api_key}}" },
  },
});

const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) { name }
  }
`;

export const getUser = test("get-user", async (ctx) => {
  const { data } = await graphql.query<{ user: { name: string } }>(
    GET_USER, { variables: { id: "1" } }
  );
  ctx.expect(data?.user.name).toBe("Alice");
});
```

> **Note**: `gql` is an identity function — it returns the string as-is.
> Its only purpose is enabling IDE syntax highlighting. For full autocomplete
> and schema validation, use `.gql` files with `fromGql()`.

#### Standalone (without `configure()`)

```typescript
import { test } from "@glubean/sdk";
import { createGraphQLClient } from "@glubean/sdk/graphql";

export const healthCheck = test("gql-health", async (ctx) => {
  const gql = createGraphQLClient(ctx.http, {
    endpoint: ctx.vars.require("GRAPHQL_URL"),
    headers: { Authorization: `Bearer ${ctx.secrets.require("API_KEY")}` },
  });

  const { data } = await gql.query<{ health: string }>(`{ health }`);
  ctx.assert(data?.health === "ok", "GraphQL service should be healthy");
});
```

#### `throwOnGraphQLErrors`

By default, GraphQL errors are returned in the response object (since GraphQL
servers typically return HTTP 200 even on errors). Enable `throwOnGraphQLErrors`
to throw automatically:

```typescript
import { GraphQLResponseError } from "@glubean/sdk";

const { graphql } = configure({
  graphql: {
    endpoint: "graphql_url",
    throwOnGraphQLErrors: true,
  },
});

export const authRequired = test("auth-required", async (ctx) => {
  try {
    await graphql.query(`{ me { name } }`);
    ctx.fail("Expected GraphQL error");
  } catch (err) {
    if (err instanceof GraphQLResponseError) {
      ctx.expect(err.errors[0].extensions?.code).toBe("UNAUTHENTICATED");
    } else {
      throw err;
    }
  }
});
```

#### GraphQL Configuration Reference

| Option                   | Type                      | Description                                               |
| ------------------------ | ------------------------- | --------------------------------------------------------- |
| `endpoint`               | `string`                  | Var key for the GraphQL URL (resolved at runtime)         |
| `headers`                | `Record<string, string>`  | Default headers with `{{key}}` template support           |
| `throwOnGraphQLErrors`   | `boolean`                 | Throw `GraphQLResponseError` on response errors (default: `false`) |

#### How Tracing Works

The GraphQL client automatically:

1. Parses the operation name from the query string (e.g., `query GetUser` → `"GetUser"`)
2. Injects it via the `X-Glubean-Op` request header
3. The runner reads this header and sets `trace.name` in the dashboard

This means your dashboard shows `GetUser`, `CreateOrder`, etc. instead of
a wall of identical `POST /graphql` entries.

You can also pass `operationName` explicitly if auto-detection doesn't work
(e.g., for dynamically built queries):

```typescript
const { data } = await graphql.query(dynamicQuery, {
  operationName: "MyCustomOperation",
  variables: { id: "1" },
});
```

## API Reference

### Functions

| Function       | Description                            |
| -------------- | -------------------------------------- |
| `test(id, fn)` | Quick mode - creates a simple test     |
| `test(id)`     | Builder mode - returns a `TestBuilder` |

### TestBuilder Methods

| Method                  | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `.meta(opts)`           | Set test metadata (tags, timeout, etc.)           |
| `.setup(fn)`            | Set setup function, returns state                 |
| `.step(name, fn)`       | Add a test step                                   |
| `.step(name, opts, fn)` | Add a step with options (retries, timeout)        |
| `.use(fn)`              | Apply a builder transform for step composition    |
| `.group(id, fn)`        | Same as `.use()` but tags steps with a group ID   |
| `.teardown(fn)`         | Set teardown function (runs even on failure)      |
| `.build()`              | Build and register (optional — auto-finalized)    |

### TestContext Properties

| Property          | Type              | Description                               |
| ----------------- | ----------------- | ----------------------------------------- |
| `vars`            | `VarsAccessor`    | Environment variables                     |
| `secrets`         | `SecretsAccessor` | Secure secrets                            |
| `log(msg, data?)` | `function`        | Log message with optional data            |
| `assert(...)`     | `function`        | Record an assertion                       |
| `trace(req)`      | `function`        | Record an API call                        |
| `skip(reason?)`   | `function`        | Dynamically skip current test             |
| `setTimeout(ms)`  | `function`        | Dynamically set timeout                   |
| `retryCount`      | `number`          | Current retry count (0 for first attempt) |

### VarsAccessor Methods

| Method         | Description                  |
| -------------- | ---------------------------- |
| `get(key)`     | Returns value or `undefined` |
| `require(key)` | Returns value or throws      |
| `all()`        | Returns all variables        |

### SecretsAccessor Methods

| Method         | Description                   |
| -------------- | ----------------------------- |
| `get(key)`     | Returns secret or `undefined` |
| `require(key)` | Returns secret or throws      |

## Best Practices

### 1. Use `require()` for Critical Variables

```typescript
// Good - fails fast with clear error
const baseUrl = ctx.vars.require("BASE_URL");

// Avoid - silent failures
const baseUrl = ctx.vars.get("BASE_URL") || "";
```

### 2. Keep Tests Independent

Each test should be able to run in isolation:

```typescript
// Good - creates its own data
export const updateUser = test("update-user", async (ctx) => {
  const user = await createUser(); // Create test data
  try {
    await updateUser(user.id, { name: "New" });
    ctx.assert(true, "Updated");
  } finally {
    await deleteUser(user.id); // Clean up
  }
});
```

### 3. Use Tags for Organization

```typescript
export const smokeTest = test({
  id: "api-health",
  tags: ["smoke", "critical", "p0"]
}, async (ctx) => { ... });

// Run only smoke tests
// glubean run --tag smoke
```

### 4. Log Meaningful Context

```typescript
ctx.log("Creating order", {
  userId: state.userId,
  items: cart.items.length,
  total: cart.total,
});
```

### 5. Use Setup/Teardown for Shared Resources

```typescript
export const dbTests = test<{ conn: Connection }>("db-tests")
  .setup(async (ctx) => {
    const conn = await db.connect();
    await conn.beginTransaction();
    return { conn };
  })
  .step("Insert", async (ctx, { conn }) => { ... })
  .step("Query", async (ctx, { conn }) => { ... })
  .teardown(async (ctx, { conn }) => {
    await conn.rollback();  // Clean up test data
    await conn.close();
  })
```

### 6. Handle Cleanup Gracefully

Teardown always runs, even on failure. Handle errors to ensure cleanup:

```typescript
export const dbTests = test<{ conn: Connection }>("db-cleanup")
  .setup(async (ctx) => {
    const conn = await db.connect();
    await conn.beginTransaction();
    return { conn };
  })
  .step("Insert", async (ctx, { conn }) => { /* ... */ })
  .step("Query", async (ctx, { conn }) => { /* ... */ })
  .teardown(async (ctx, { conn }) => {
    try {
      await conn.rollback();
      await conn.close();
    } catch (err) {
      ctx.log("Cleanup failed:", err.message);
    }
  });
```

## Version

Current SDK spec version: **2.0**

```typescript
import { SPEC_VERSION } from "@glubean/sdk";
console.log(SPEC_VERSION); // "2.0"
```

## License

MIT
