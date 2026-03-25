# CRUD with Setup/Teardown

## When to use builder mode

Use builder mode (`.setup()` / `.step()` / `.teardown()`) when your test:
- Creates resources that must be cleaned up
- Has multiple sequential steps that depend on each other

For simple read-only tests, quick mode (callback) is fine.

## Quick mode has NO teardown

```typescript
// ❌ WRONG: teardown does not exist on TestContext — crashes at runtime
export const createThing = test("create", async ({ teardown }) => {
  const res = await api.post("things", { json: { name: "test" } }).json<{ id: string }>();
  teardown(async () => { await api.delete(`things/${res.id}`); }); // undefined!
});

// ✅ RIGHT: use builder mode for cleanup
```

## Full CRUD example (builder mode)

Multi-step test: create a resource, verify, update, then always clean up.

```typescript
// tests/api/projects.test.ts
import { test } from "@glubean/sdk";
import { api } from "../../config/api.ts";

export const projectsCrud = test("projects-crud")
  .meta({ name: "Projects CRUD lifecycle", tags: ["api", "projects"] })
  .setup(async ({ log }) => {
    log("Creating test project");
    const project = await api
      .post("projects", { json: { name: "test-project", teamId: "my-team" } })
      .json<{ id: string }>();
    return { projectId: project.id };
  })
  .step("read", async ({ expect }, state) => {
    const project = await api.get(`projects/${state.projectId}`).json<{ name: string }>();
    expect(project.name).toBe("test-project");
    return state;
  })
  .step("update", async ({ expect }, state) => {
    const updated = await api
      .put(`projects/${state.projectId}`, { json: { name: "renamed" } })
      .json<{ name: string }>();
    expect(updated.name).toBe("renamed");
    return state;
  })
  .teardown(async ({ log }, state) => {
    if (state?.projectId) {
      await api.delete(`projects/${state.projectId}`);
      log(`Cleaned up project ${state.projectId}`);
    }
  });
```

## Key points

- **`.teardown()` always runs**, even when a step fails — use it for cleanup
- Each `.step()` receives state from the previous step and returns new state
- Steps appear as separate entries in reports with individual durations
