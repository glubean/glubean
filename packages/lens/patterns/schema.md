# Schema Validation (Zod)

Validate API response structure against a Zod schema.

```typescript
import { test } from "@glubean/sdk";
import { z } from "zod";
import { api } from "../../config/api.ts";

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string().datetime(),
  team: z.object({
    id: z.string(),
    name: z.string(),
  }),
});

export const projectSchema = test(
  { id: "project-schema", name: "Project response matches schema", tags: ["api", "schema"] },
  async ({ validate }) => {
    const project = await api.get("projects").json();
    validate(project, z.array(ProjectSchema), "Project list");
  },
);
```

## Key points

- `ctx.validate(data, schema, label?)` — validates and reports mismatches as assertion failures
- Use Zod v4 (`import { z } from "zod"`)
- Third argument `label` appears in failure messages for clarity
