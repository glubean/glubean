# Custom Metrics

Record performance measurements visible in Cloud dashboard.

```typescript
import { test } from "@glubean/sdk";
import { api } from "../../config/api.ts";

export const responseTime = test(
  { id: "response-time", name: "API response time under threshold", tags: ["perf"] },
  async ({ expect, metric }) => {
    const start = performance.now();
    await api.get("projects").json();
    const duration = performance.now() - start;

    metric("api.projects.list", duration, {
      unit: "ms",
      tags: { endpoint: "/projects" },
    });
    expect(duration).toBeLessThan(2000);
  },
);
```

## Key points

- `ctx.metric(name, value, { unit?, tags? })` — records a named metric
- Metrics appear in Cloud analytics with tags for filtering
- Common units: `"ms"`, `"bytes"`, `"count"`
