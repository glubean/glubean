# Data-Driven Tests

## test.each — one file = one case

Each JSON file in the directory becomes a separate test.

```
data/users/
  alice.json    → { "username": "alice", "expectedStatus": 200 }
  bob.json      → { "username": "bob", "expectedStatus": 200 }
  unknown.json  → { "username": "no-one", "expectedStatus": 404 }
```

```typescript
import { test, fromDir } from "@glubean/sdk";
import { api } from "../../config/api.ts";

interface UserCase {
  username: string;
  expectedStatus: number;
}

const users = await fromDir<UserCase>("./data/users/");

// Quick mode
export const userLookup = test.each(users)(
  "user-lookup-$username",              // $field interpolates from row
  async ({ expect }, { username, expectedStatus }) => {
    const res = await api.get(`users/${username}`);
    expect(res).toHaveStatus(expectedStatus);
  },
);

// Builder mode (omit callback)
export const userFlow = test.each(users)("user-flow-$username")
  .step("fetch", async (ctx, _state, row) => {
    const res = await ctx.http.get(`/users/${row.username}`).json<{ id: string }>();
    return { id: res.id };
  })
  .step("verify", async (ctx, state) => {
    ctx.expect(state.id).toBeDefined();
  });
```

## test.pick — named cases, merged files

`shared.json` has defaults. `*.local.json` for personal overrides (gitignored).

```
data/search/
  shared.json       → { "basic": { "q": "test", "min": 1 }, "empty": { "q": "xyznotfound", "min": 0 } }
  mine.local.json   → { "basic": { "q": "my-custom-query", "min": 5 } }
```

```typescript
import { test, fromDir } from "@glubean/sdk";
import { api } from "../../config/api.ts";

const queries = await fromDir.merge<{ q: string; min: number }>("./data/search/");

export const searchTests = test.pick(queries)(
  "search-$_pick",                      // $_pick = case name
  async ({ expect }, { q, min }) => {
    const res = await api
      .get("products/search", { searchParams: { q } })
      .json<{ total: number }>();
    expect(res.total).toBeGreaterThanOrEqual(min);
  },
);
```

## Inline data (no files needed)

```typescript
// test.each — array of objects
test.each([
  { id: 1, expected: 200 },
  { id: 999, expected: 404 },
])("get-user-$id", async (ctx, { id, expected }) => { ... });

// test.pick — object with named keys
test.pick({
  "normal":    { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
})("create-user-$_pick", async (ctx, data) => { ... });
```

## Other data loaders

```typescript
const rows = await fromCsv<T>("./data/file.csv");
const rows = await fromYaml<T>("./data/file.yaml");
const rows = await fromJsonl<T>("./data/file.jsonl");
const items = await fromDir.concat<T>("./data/items/");  // Concatenate arrays from files
```
