# Error / Negative Tests

Test that your API rejects bad requests correctly.

## 404 Not Found

```typescript
import { test } from "@glubean/sdk";
import { api } from "../../config/api.ts";

export const notFound = test(
  { id: "not-found", name: "404 for missing resource", tags: ["api", "errors"] },
  async ({ expect }) => {
    const res = await api.get("projects/nonexistent");
    expect(res).toHaveStatus(404);
  },
);
```

## 401 Unauthorized

```typescript
export const unauthorized = test(
  { id: "no-auth", name: "401 without token", tags: ["api", "errors"] },
  async ({ http, expect }) => {
    const res = await http.get("https://api.example.com/protected");
    expect(res).toHaveStatus(401);
  },
);
```

## 422 Validation Error

```typescript
export const invalidInput = test(
  { id: "invalid-input", name: "422 for bad payload", tags: ["api", "errors"] },
  async ({ expect }) => {
    const res = await api.post("projects", {
      json: { name: "" },  // Empty name should fail validation
    });
    expect(res).toHaveStatus(422);
    const body = await res.json<{ message: string }>();
    expect(body.message).toContain("name");
  },
);
```

## Pattern: cover all error boundaries per endpoint

For each endpoint, consider testing:
- **401/403** — missing or invalid credentials
- **400/422** — invalid input, missing required fields
- **404** — nonexistent resource
- **409** — conflict (duplicate create)
