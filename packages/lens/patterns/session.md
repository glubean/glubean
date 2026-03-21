# Session — Cross-File Shared State

Share state (auth tokens, IDs) across test files without re-authenticating.

## Session setup file

```typescript
// session.ts (or configure in package.json "glubean.session")
import { defineSession, configure } from "@glubean/sdk";

const { http } = configure({
  http: { prefixUrl: "{{DUMMYJSON_API}}" },
});

// This runs once before all files that use session state
export default defineSession({
  async setup(ctx) {
    const res = await http.post("auth/login", {
      json: { username: "emilys", password: "emilyspass" },
    }).json<{ accessToken: string; id: number }>();

    ctx.session.set("authToken", res.accessToken);
    ctx.session.set("userId", res.id);
  },
});
```

## Using session state in tests

```typescript
// tests/profile.test.ts
import { test, configure } from "@glubean/sdk";

const { http } = configure({
  http: { prefixUrl: "{{DUMMYJSON_API}}" },
});

export const getOwnProfile = test("get-own-profile", async (ctx) => {
  const token = ctx.session.require("authToken");  // From session setup

  const res = await http.get("auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  ctx.expect(res).toHaveStatus(200);

  const body = await res.json<{ id: number; username: string }>();
  ctx.assert(body.username === "emilys", `expected emilys, got ${body.username}`);
});
```

## Multi-step workflow using session

```typescript
// tests/cart-workflow.test.ts
import { test, configure } from "@glubean/sdk";

const { http } = configure({
  http: { prefixUrl: "{{DUMMYJSON_API}}" },
});

export const cartWorkflow = test("cart-workflow")
  .step("create-cart", async (ctx) => {
    const token = ctx.session.require("authToken");
    const userId = ctx.session.require("userId");

    const res = await http.post("carts/add", {
      json: { userId, products: [{ id: 1, quantity: 2 }] },
      headers: { Authorization: `Bearer ${token}` },
    });

    ctx.expect(res).toHaveStatus(201);
    const body = await res.json<{ id: number }>();
    return { cartId: body.id };
  })
  .step("verify-cart", async (ctx, state) => {
    const token = ctx.session.require("authToken");
    const res = await http.get(`carts/${state.cartId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ctx.expect(res).toHaveStatus(200);
  });
```

## Key points

- `ctx.session.require("key")` — get session value (throws if missing)
- `ctx.session.set("key", value)` — set session value in setup
- `ctx.session.get("key")` — get session value (returns undefined if missing)
- Use `defineSession()` with `export default` — the runner auto-discovers `session.ts`
- Session setup runs once, state is injected into all test files
- Use for: auth tokens, user IDs, shared resources that are expensive to create
