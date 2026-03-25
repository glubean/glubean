# Data-Driven Tests

## Which one to use?

| | `test.each` | `test.pick` |
|---|---|---|
| **Runs** | **All** cases | **One selected** case |
| **Use case** | Regression, coverage | Explore, debug, ad-hoc |
| **Data source** | Array, `fromDir`, `fromCsv`, `fromYaml` | Object map, `fromDir.merge`, `fromYaml` + `.local.json` |
| **Filter** | `--filter` by test id | `--pick` to select by key |

**Rule of thumb:** need to run every case → `.each`. Need to pick one and iterate → `.pick`.

## test.each — runs ALL cases

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

// ⚠️ Use `type`, not `interface` — fromDir generics require an index signature.
type UserCase = {
  username: string;
  expectedStatus: number;
};

const users = await fromDir<UserCase>("data/users/");

// Quick mode — string ID
export const userLookup = test.each(users)(
  "user-lookup-$username",              // $field interpolates from row
  async ({ expect }, { username, expectedStatus }) => {
    const res = await api.get(`users/${username}`);
    expect(res).toHaveStatus(expectedStatus);
  },
);

// Quick mode — TestMeta object (with tags)
export const userLookupTagged = test.each(users)(
  { id: "user-lookup-$username", tags: ["smoke", "api"] },
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

## test.pick — runs ONE selected case

`shared.json` has defaults. `*.local.json` for personal overrides (gitignored).

```
data/search/
  shared.json       → { "basic": { "q": "test", "min": 1 }, "empty": { "q": "xyznotfound", "min": 0 } }
  mine.local.json   → { "basic": { "q": "my-custom-query", "min": 5 } }
```

```typescript
import { test, fromDir } from "@glubean/sdk";
import { api } from "../../config/api.ts";

const queries = await fromDir.merge<{ q: string; min: number }>("data/search/");

// String ID
export const searchTests = test.pick(queries)(
  "search-$_pick",                      // $_pick = case name
  async ({ expect }, { q, min }) => {
    const res = await api
      .get("products/search", { searchParams: { q } })
      .json<{ total: number }>();
    expect(res.total).toBeGreaterThanOrEqual(min);
  },
);

// TestMeta object (with tags)
export const searchTagged = test.pick(queries)(
  { id: "search-$_pick", name: "Search: $_pick", tags: ["api"] },
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
// test.each — string ID
test.each([
  { id: 1, expected: 200 },
  { id: 999, expected: 404 },
])("get-user-$id", async (ctx, { id, expected }) => { ... });

// test.each — TestMeta object (with tags)
test.each([
  { id: 1, expected: 200 },
  { id: 999, expected: 404 },
])({ id: "get-user-$id", tags: ["smoke"] }, async (ctx, { id, expected }) => { ... });

// test.pick — string ID
test.pick({
  "normal":    { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
})("create-user-$_pick", async (ctx, data) => { ... });

// test.pick — TestMeta object (with tags)
test.pick({
  "normal":    { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
})({ id: "create-user-$_pick", tags: ["api"] }, async (ctx, data) => { ... });
```

## Advanced: Structured Test Data

For complex scenarios, flat key-value pairs are not enough. Use a YAML file where each case has nested `request` and `expect` blocks — data drives both the input **and** the assertions.

### YAML data file

```yaml
# data/search-queries.yaml
# Each top-level key is a test case name.
# Structure is arbitrary — not limited to flat key-value.

# Search by product name — basic keyword search
by-name:
  description: Search by product name          # human-readable label for logs
  request:                                      # drives the HTTP request
    q: phone
  expect:                                       # drives assertions
    minResults: 1

# Search by category — broader search
by-category:
  description: Search products by category keyword
  request:
    q: laptops
  expect:
    minResults: 1

# Edge case — empty query
empty-query:
  description: Empty query returns nothing
  request:
    q: ""
  expect:
    minResults: 0
```

### TypeScript test file

```typescript
import { fromYaml, test } from "@glubean/sdk";

// Use `type`, not `interface`, for data shapes.
type SearchCase = {
  description: string;
  request: { q: string };
  expect: { minResults: number };
};

const cases = await fromYaml<Record<string, SearchCase>>(
  "data/search-queries.yaml",
);

export const search = test.each(Object.entries(cases).map(
  ([key, c]) => ({ _key: key, ...c }),
))(
  "search-$_key",
  async (ctx, { description, request, expect: exp }) => {
    ctx.log(description);

    const result = await ctx.http
      .get("https://dummyjson.com/products/search", {
        searchParams: { q: request.q },
      })
      .json<{ total: number }>();

    ctx.expect(result.total).toBeGreaterThanOrEqual(exp.minResults);
  },
);
```

### Key takeaways

1. **`description` in data** — each case carries a human-readable label so logs and results are easy to scan without reading the YAML.
2. **`request` + `expect` separation** — data simultaneously drives both the input (what to send) and the assertions (what to check). One file, two purposes.
3. **Arbitrary structure** — YAML cases are not limited to flat key-value. Nest as deep as needed (`request.headers`, `expect.schema`, etc.).

## Other data loaders

```typescript
const rows = await fromCsv<T>("data/file.csv");
const rows = await fromYaml<T>("data/file.yaml");
const rows = await fromJsonl<T>("data/file.jsonl");
const items = await fromDir.concat<T>("data/items/");  // Concatenate arrays from files
```
