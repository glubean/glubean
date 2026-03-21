# Builder API + Reusable Steps

Multi-step tests with shared state, and `.use()` / `.group()` for reusable sequences.

## Builder pattern (multi-step with state)

```typescript
import { test } from "@glubean/sdk";

export const authFlow = test("auth-flow")
  .meta({ name: "Login then access protected resource", tags: ["api", "auth"] })
  .step("login", async ({ http, expect, secrets }) => {
    const res = await http.post("https://api.example.com/auth/token-login", {
      json: { apiKey: secrets.require("API_KEY") },
    }).json<{ token: string }>();
    expect(res.token).toBeDefined();
    return { token: res.token };
  })
  .step("access profile", async ({ http, expect }, state) => {
    const authed = http.extend({
      headers: { Authorization: `Bearer ${state.token}` },
    });
    const profile = await authed.get("https://api.example.com/auth/profile").json<{ email: string }>();
    expect(profile.email).toBeDefined();
  });
```

## Reusable steps with `.use()`

Extract common sequences into plain functions and share across tests:

```typescript
// TestBuilder<T> generic = accumulated state from previous steps
// unknown = no dependency on prior state
const withAuth = (b: TestBuilder<unknown>) => b
  .step("login", async (ctx) => {
    const { token } = await ctx.http.post("/login", {
      json: { username: ctx.secrets.require("USERNAME"), password: ctx.secrets.require("PASSWORD") },
    }).json<{ token: string }>();
    return { token };
  });

export const testA = test("test-a").use(withAuth).step("act", async (ctx, { token }) => { ... });
export const testB = test("test-b").use(withAuth).step("verify", async (ctx, { token }) => { ... });
```

## Visual grouping with `.group()`

Same as `.use()` but tags steps for grouped display in reports:

```typescript
export const checkout = test("checkout")
  .group("auth", withAuth)
  .step("pay", async (ctx, { token }) => { ... });
// Report: checkout → [auth] login → pay
```

## Key points

- Each `.step()` receives state from the previous step and returns new state
- `.use()` is for logic reuse, `.group()` adds visual grouping in reports
- For common auth patterns (bearer, API key, basic, OAuth2), prefer `@glubean/auth` plugin — see [auth.md](auth.md)
