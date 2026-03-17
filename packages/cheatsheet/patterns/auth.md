# Auth Flow

Login, get token, use it on protected endpoints.

## Builder pattern (multi-step)

```typescript
// tests/api/auth.test.ts
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

## Reusable auth with `.use()`

```typescript
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

## Unauthorized (negative test)

```typescript
export const unauthorized = test(
  { id: "unauthorized-access", tags: ["api", "auth"] },
  async ({ http, expect }) => {
    const res = await http.get("https://api.example.com/protected");
    expect(res).toHaveStatus(401);
  },
);
```
