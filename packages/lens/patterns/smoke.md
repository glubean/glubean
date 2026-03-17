# Smoke Test

Simplest test — hit one endpoint, check it responds correctly.

```typescript
// tests/api/health.test.ts
import { test } from "@glubean/sdk";
import { api } from "../../config/api.ts";

export const healthCheck = test(
  { id: "health-check", name: "Health endpoint returns 200", tags: ["smoke"] },
  async ({ expect }) => {
    const res = await api.get("health").json<{ status: string }>();
    expect(res.status).toBe("ok");
  },
);
```

## Smoke with multiple checks

```typescript
export const getProduct = test(
  { id: "get-product", name: "GET single product", tags: ["smoke", "api"] },
  async ({ expect, log }) => {
    const product = await api.get("products/1").json<{
      id: number;
      title: string;
      price: number;
    }>();

    expect(product.id).toBe(1);
    expect(product.title).toBeDefined();
    expect(product.price).toBeGreaterThan(0);
    log(`${product.title} — $${product.price}`);
  },
);
```
