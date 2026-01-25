# Assertions, Warnings, and Schema Validation

This guide covers the assertion and validation APIs available in the Glubean
SDK.

## Quick Reference

| API                          | Behavior                           | Test fails?             |
| ---------------------------- | ---------------------------------- | ----------------------- |
| `ctx.assert(cond, msg)`      | Hard check — records pass/fail     | Yes (on false)          |
| `ctx.expect(val)`            | Fluent assertions, soft-by-default | No (unless `.orFail()`) |
| `ctx.warn(cond, msg)`        | Soft check — records warning       | Never                   |
| `ctx.validate(data, schema)` | Schema validation with severity    | Depends on severity     |
| `ctx.fail(msg)`              | Immediately abort test             | Always                  |

---

## ctx.expect — Fluent Assertions

Jest/Vitest-style fluent API. **Soft-by-default**: failed assertions are
recorded but do not throw, so all checks run and all failures are collected.

### Value Assertions

```ts
ctx.expect(res.status).toBe(200);
ctx.expect(body).toEqual({ id: 1, name: "Alice" });
ctx.expect(body.name).toBeType("string");
ctx.expect(body.active).toBeTruthy();
ctx.expect(body.deleted).toBeFalsy();
ctx.expect(body.avatar).toBeNull();
ctx.expect(body.nickname).toBeUndefined();
ctx.expect(body.id).toBeDefined();
```

### Numeric Assertions

```ts
ctx.expect(body.age).toBeGreaterThan(0);
ctx.expect(body.age).toBeLessThan(200);
ctx.expect(body.score).toBeWithin(0, 100);
```

### Collection and String Assertions

```ts
ctx.expect(body.roles).toHaveLength(3);
ctx.expect(body.roles).toContain("admin");
ctx.expect(body.email).toMatch(/@example\.com$/);
ctx.expect(body).toMatchObject({ success: true });
ctx.expect(body).toHaveProperty("id");
ctx.expect(body).toHaveProperty("meta.created", "2024-01-01");
```

### Custom Predicate

```ts
ctx.expect(body).toSatisfy((b) => b.items.length > 0, "should have items");
```

### HTTP-specific

```ts
ctx.expect(res).toHaveStatus(200);
ctx.expect(res).toHaveHeader("content-type", /json/);
```

### Negation

Prefix any assertion with `.not`:

```ts
ctx.expect(body.banned).not.toBe(true);
ctx.expect(body.roles).not.toContain("superadmin");
```

### Guard — `.orFail()`

By default, `ctx.expect` is soft (records failure but continues). Use
`.orFail()` when subsequent code depends on the assertion passing:

```ts
// If status is not 200, abort immediately — don't try to parse body
ctx.expect(res.status).toBe(200).orFail();
const body = await res.json(); // safe to call
ctx.expect(body.name).toBe("Alice");
```

### Why Soft-by-Default?

In API testing, you often want to see **all** failures at once rather than
fixing them one at a time. Soft assertions collect every failure in a single
run:

```ts
// All 3 assertions run even if the first fails
ctx.expect(body.status).toBe("active");
ctx.expect(body.email).toMatch(/@/);
ctx.expect(body.roles).toContain("admin");
```

---

## ctx.assert — Low-level Assertion

The classic boolean assertion. Records pass/fail but does not throw.

```ts
ctx.assert(res.status === 200, "Status should be 200", {
  actual: res.status,
  expected: 200,
});
```

Or with a result object:

```ts
ctx.assert(
  { passed: body.id > 0, actual: body.id, expected: "> 0" },
  "ID should be positive"
);
```

> **Tip:** Prefer `ctx.expect` for readability. Use `ctx.assert` when you need
> direct boolean logic or are migrating from the older API.

---

## ctx.warn — Soft Check (Should, not Must)

Warnings are recorded but **never** affect test pass/fail. Use them for
best-practice checks, performance budgets, or deprecation notices.

```ts
// Performance budget
ctx.warn(duration < 500, "Response should be under 500ms");

// Best practice
ctx.warn(res.headers.has("cache-control"), "Should have cache headers");

// Security
ctx.warn(avatarUrl.startsWith("https"), "Avatar should use HTTPS");
```

Mental model:

- `ctx.assert` / `ctx.expect` = **must** (failure = test fails)
- `ctx.warn` = **should** (failure = recorded, test still passes)

---

## ctx.validate — Schema Validation

Validate data against a schema library (Zod, Valibot, ArkType, or any object
with `safeParse` or `parse`). Returns the parsed value on success, `undefined`
on failure.

### Basic Usage

```ts
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

const user = ctx.validate(body, UserSchema, "response body");
// user is typed as { id: number; name: string; email: string } | undefined
```

### Severity

Control what happens when validation fails:

```ts
// "error" (default) — counts as a failed assertion
ctx.validate(body, UserSchema, "response body");

// "warn" — warning only, test still passes
ctx.validate(body, StrictSchema, "strict contract", { severity: "warn" });

// "fatal" — immediately abort test
ctx.validate(body, UserSchema, "response body", { severity: "fatal" });
```

| Severity  | Assertion?             | Test fails? | Throws?      |
| --------- | ---------------------- | ----------- | ------------ |
| `"error"` | Yes (failed assertion) | Yes         | No           |
| `"warn"`  | No (warning only)      | No          | No           |
| `"fatal"` | Yes (failed assertion) | Yes         | Yes (aborts) |

### Schema-agnostic

The SDK uses a `SchemaLike<T>` protocol — any library that implements
`safeParse()` or `parse()` works:

```ts
// Zod (recommended)
const schema = z.object({ id: z.number() });

// Valibot
import * as v from "valibot";
const schema = v.object({ id: v.number() });

// Custom
const schema = {
  safeParse(data: unknown) {
    if (typeof data === "string") return { success: true, data };
    return {
      success: false,
      error: { issues: [{ message: "expected string" }] },
    };
  },
};
```

---

## HTTP Schema Integration

Validate request and response bodies automatically by adding a `schema` option
to any `ctx.http` call.

### Response Validation

```ts
const res = await ctx.http.get(`${baseUrl}/users/1`, {
  schema: { response: UserSchema },
});
const user = await res.json(); // validated automatically
```

### Request Body Validation

```ts
await ctx.http.post(`${baseUrl}/users`, {
  json: payload,
  schema: { request: CreateUserSchema },
});
```

### Query Params Validation

```ts
await ctx.http.get(`${baseUrl}/users`, {
  searchParams: { page: 1, limit: 10 },
  schema: { query: PaginationSchema },
});
```

### Combined

```ts
const res = await ctx.http.post(`${baseUrl}/users`, {
  json: payload,
  searchParams: { org: "acme" },
  schema: {
    request: CreateUserSchema,
    response: UserSchema,
    query: OrgQuerySchema,
  },
});
```

### Custom Severity

Each schema entry can specify its own severity:

```ts
await ctx.http.get(`${baseUrl}/users`, {
  searchParams: params,
  schema: {
    query: { schema: QuerySchema, severity: "warn" },
    response: { schema: ResponseSchema, severity: "fatal" },
  },
});
```

---

## Fail-fast

Stop running tests early when failures accumulate.

### CLI Options

```bash
# Stop on first failure
glubean run api.test.ts --fail-fast

# Stop after 3 failures
glubean run api.test.ts --fail-after 3
```

Remaining tests are marked as **skipped** in the output:

```
  ● Create User
    ✗ FAILED (120ms)
  ○ Update User (skipped — fail-fast)
  ○ Delete User (skipped — fail-fast)

─────────────────────────────────────
Tests:  0 passed, 1 failed, 2 skipped
Total:  3
```

### Programmatic (Executor API)

```ts
const batch = await executor.executeMany(url, testIds, context, {
  stopOnFailure: true, // stop on first failure
  // or
  failAfter: 3, // stop after 3 failures
});

console.log(batch.skippedCount); // number of tests not run
```

---

## Event Model

All assertion/validation APIs emit structured events consumed by the runner:

| Event type          | Emitted by                  |
| ------------------- | --------------------------- |
| `assertion`         | `ctx.assert`, `ctx.expect`  |
| `warning`           | `ctx.warn`                  |
| `schema_validation` | `ctx.validate`, HTTP schema |

The `summary` event includes counters for all:

```json
{
  "type": "summary",
  "data": {
    "assertionTotal": 5,
    "assertionFailed": 1,
    "warningTotal": 2,
    "warningTriggered": 1,
    "schemaValidationTotal": 3,
    "schemaValidationFailed": 1,
    "schemaValidationWarnings": 0
  }
}
```

---

## Comparison with Other Frameworks

| Feature                   | Glubean       | Jest/Vitest       | Playwright       | Chai |
| ------------------------- | ------------- | ----------------- | ---------------- | ---- |
| Soft-by-default           | Yes           | No                | `expect.soft`    | No   |
| `.orFail()` guard         | Yes           | N/A (always hard) | N/A              | N/A  |
| `ctx.warn` (non-failing)  | Yes           | No                | No               | No   |
| Schema validation         | Built-in      | Manual            | No               | No   |
| HTTP schema auto-validate | Built-in      | No                | No               | No   |
| Fail-fast (CLI)           | `--fail-fast` | `--bail`          | `--max-failures` | N/A  |
