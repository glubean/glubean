# Data Loading for Data-Driven Tests

This guide covers how to load test data from files and directories for use with `test.each()`.

## Quick Reference

| Data Format   | Recommended Approach                       |
| ------------- | ------------------------------------------ |
| **JSON**      | Native `import` — no SDK helper needed     |
| **CSV**       | `fromCsv("./data.csv")`                    |
| **YAML**      | `fromYaml("./data.yaml")`                  |
| **JSONL**     | `fromJsonl("./data.jsonl")`                |
| **Directory** | `fromDir("./cases/")`                      |
| **DB / API**  | User top-level `await` + `test.each(rows)` |

All file paths are **relative to the project root** (the directory containing `deno.json`).

## Troubleshooting Path Errors

If a loader cannot find a file or directory, the error now includes:

- current working directory (`Deno.cwd()`)
- resolved absolute path
- quick hints for common fixes

Typical causes:

- using import-relative paths instead of project-root-relative paths
- running from a different directory than expected
- typo in file extension or folder name

Example:

```
Failed to read file: "./data/cases.csv"
Current working directory: /Users/me/project
Resolved path: /Users/me/project/data/cases.csv
Hint: data loader paths are resolved from project root (where "deno.json" is).
Hint: if your file is in the standard data folder, use a path like "./data/cases.csv".
```

---

## JSON — Use Native Import

For JSON files, use Deno's native import syntax. No SDK helper needed.

```ts
import { test } from "@glubean/sdk";
import cases from "./data/cases.json" with { type: "json" };

export const tests = test.each(cases)(
  "get-user-$id",
  async (ctx, { id, expected }) => {
    const res = await ctx.http.get(`${baseUrl}/users/${id}`);
    ctx.assert(res.status === expected, "status check");
  },
);
```

For nested JSON where the array is under a key:

```ts
import raw from "./data/export.json" with { type: "json" };

// Just destructure — no special API needed
export const tests = test.each(raw.requests)
  ("req-$index", async (ctx, row) => { ... });
```

---

## CSV

```ts
import { fromCsv, test } from "@glubean/sdk";

export const tests = test.each(await fromCsv("./data/cases.csv"))(
  "case-$index-$country",
  async (ctx, row) => {
    // All CSV values are strings
    const res = await ctx.http.get(`${baseUrl}/users/${row.id}`);
    ctx.assert(res.status === row.expected, "status check");
  },
);
```

### Options

| Option      | Type      | Default | Description                       |
| ----------- | --------- | ------- | --------------------------------- |
| `headers`   | `boolean` | `true`  | First row contains column headers |
| `separator` | `string`  | `","`   | Column separator character        |

```ts
// TSV file
const data = await fromCsv("./data/cases.tsv", { separator: "\t" });

// No headers — keys are "0", "1", "2", ...
const data = await fromCsv("./data/raw.csv", { headers: false });
```

---

## YAML

```ts
import { test, fromYaml } from "@glubean/sdk";

// Top-level array
export const tests = test.each(await fromYaml("./data/cases.yaml"))
  ("case-$id", async (ctx, row) => { ... });
```

For nested YAML where the array is under a key, use the `pick` option:

```yaml
# collection.yaml
info:
  name: API Tests
testCases:
  - id: 1
    expected: 200
  - id: 2
    expected: 404
```

```ts
const data = await fromYaml("./data/collection.yaml", { pick: "testCases" });
```

### Options

| Option | Type     | Default | Description                                                      |
| ------ | -------- | ------- | ---------------------------------------------------------------- |
| `pick` | `string` | —       | Dot-path to the array (e.g., `"testCases"` or `"data.requests"`) |

If the root is an object and no `pick` is provided, the SDK throws a helpful error listing discovered array fields:

```
Error: ./data/collection.yaml: root is an object, not an array.
Found these array fields: "testCases" (2 items)
Hint: use { pick: "testCases" } to select one.
```

---

## JSONL (JSON Lines)

Each line is a standalone JSON object. Useful for log-style data or streaming exports.

```ts
import { fromJsonl, test } from "@glubean/sdk";

export const tests = test.each(await fromJsonl("./data/requests.jsonl"))(
  "req-$index",
  async (ctx, row) => {
    const res = await ctx.http[row.method.toLowerCase()](
      `${baseUrl}${row.url}`,
    );
    ctx.assert(res.status === row.expected, "status check");
  },
);
```

---

## Directory of Files

### Default Mode — One File Per Test

Each file becomes one row in the data table. The file contents are spread into the row, plus `_name` (filename without
extension) and `_path` (relative path) are auto-injected.

```
cases/
  user-1.json   → { "id": 1, "expected": 200 }
  user-999.json → { "id": 999, "expected": 404 }
```

```ts
import { fromDir, test } from "@glubean/sdk";

export const tests = test.each(await fromDir("./cases/"))(
  "case-$_name",
  async (ctx, row) => {
    // row._name = "user-1", row.id = 1, row.expected = 200
    const res = await ctx.http.get(`${baseUrl}/users/${row.id}`);
    ctx.assert(res.status === row.expected, "status check");
  },
);
```

### `fromDir.concat` — Multiple Slices Into One Table

Each file contains an array. All arrays are concatenated into one flat table.

```
batches/
  batch-001.json → [{ id: 1, ... }, { id: 2, ... }]
  batch-002.json → [{ id: 3, ... }, { id: 4, ... }]
```

```ts
export const tests = test.each(
  await fromDir.concat("./batches/")
)("case-$id", async (ctx, row) => { ... });
```

Use `pick` to extract a nested array from each file:

```ts
const data = await fromDir.concat("./specs/", {
  ext: ".yaml",
  pick: "cases",
});
```

### `fromDir.merge` — Split Named Examples for `test.pick`

Each file contains a named object map. All objects are shallow-merged into one combined map, ready for `test.pick()`.
Files are sorted alphabetically; later files override keys from earlier ones when there's a conflict.

This is useful when the same kind of data is segmented by region, environment, tenant, or any other dimension — each
segment lives in its own file.

```
data/regions/
  eu-west.json  → { "eu-west-1": { "endpoint": "...", "currency": "EUR" },
                     "eu-west-2": { "endpoint": "...", "currency": "GBP" } }
  us-east.json  → { "us-east-1": { "endpoint": "...", "currency": "USD" },
                     "us-east-2": { "endpoint": "...", "currency": "USD" } }
```

```ts
import { fromDir, test } from "@glubean/sdk";

const allRegions = await fromDir.merge("./data/regions/");
// → { "eu-west-1": {...}, "eu-west-2": {...}, "us-east-1": {...}, "us-east-2": {...} }

export const regionTests = test.pick(allRegions)(
  "region-$_pick",
  async (ctx, data) => {
    const res = await ctx.http.get(data.endpoint);
    ctx.expect(res).toHaveStatus(200);
  },
);
```

### Shared Options

All three modes (`fromDir`, `fromDir.concat`, `fromDir.merge`) accept:

| Option      | Type                 | Default   | Description                 |
| ----------- | -------------------- | --------- | --------------------------- |
| `ext`       | `string \| string[]` | `".json"` | File extensions to include  |
| `recursive` | `boolean`            | `false`   | Recurse into subdirectories |

`fromDir.concat` additionally accepts:

| Option | Type     | Default | Description                                    |
| ------ | -------- | ------- | ---------------------------------------------- |
| `pick` | `string` | —       | Dot-path to array inside each file (JSON/YAML) |

```ts
// Multiple file types
const data = await fromDir("./data/", {
  ext: [".json", ".yaml"],
});
```

---

## `test.pick` — Named Examples

`test.pick` is designed for named example maps (`Record<string, T>`). It wraps `test.each` internally, so all
`test.each` options (`filter`, `tagFields`, `tags`) work transparently.

There are two common usage patterns with different tradeoffs:

### Explore Mode — Interactive Development

In `.explore.ts` files, use `test.pick` with a **JSON import** or **inline object**. This enables **CodeLens buttons**
in VS Code — you see each example as a clickable button above the code.

```ts
// explore/create-user.explore.ts
import examples from "../data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, data) => {
    await ctx.http.post("/api/users", { json: data });
  },
);
```

> **CodeLens requires static analysis.** The VS Code extension can resolve keys from inline object literals and JSON
> imports. If you use `fromDir()`, `fromYaml()`, or any dynamic expression, the extension cannot determine the keys at
> edit time and CodeLens will fall back to "Run (random)" plus a searchable Quick Pick list.

### Test Mode — CI Full Coverage

In `.test.ts` files, use `test.pick` with `fromDir.merge()` for large, segmented datasets. CodeLens buttons are not
available here, but that's fine — in CI you run everything with `--pick all` anyway.

```ts
// tests/region.test.ts
import { fromDir, test } from "@glubean/sdk";

const allRegions = await fromDir.merge("./data/regions/");

export const regionTests = test.pick(allRegions)(
  "region-$_pick",
  async (ctx, data) => {
    const res = await ctx.http.get(data.endpoint);
    ctx.expect(res).toHaveStatus(200);
  },
);
```

### Choosing Between the Two

|                      | Explore (`.explore.ts`)             | Test (`.test.ts`)                     |
| -------------------- | ----------------------------------- | ------------------------------------- |
| **Data source**      | JSON import or inline object        | `fromDir.merge()`, any dynamic source |
| **CodeLens**         | Full: clickable buttons per example | Fallback: "Run (random)" + Quick Pick |
| **Default behavior** | Random 1 (click to pick)            | Random 1 (use `--pick all` in CI)     |
| **Best for**         | Interactive development, debugging  | CI full coverage, large datasets      |

### Selection via CLI

```bash
glubean run file.ts                        # random 1 (default)
glubean run file.ts --pick all             # every example (CI)
glubean run file.ts --pick normal          # specific example
glubean run file.ts --pick normal,admin    # multiple examples
glubean run file.ts --pick 'us-*'          # glob pattern
glubean run file.ts --pick 'us-*,eu-*'    # multiple globs
```

### With `filter` and `tagFields`

Because `test.pick` returns the same thing as `test.each`, metadata options work identically:

```ts
export const regionTests = test.pick(allRegions)({
  id: "region-$_pick",
  tagFields: ["currency", "_pick"],
  filter: (row) => row.currency === "USD",
}, async (ctx, data) => {
  const res = await ctx.http.get(data.endpoint);
  ctx.expect(res).toHaveStatus(200);
});
```

Then filter at runtime:

```bash
glubean run --tag currency:USD             # only USD regions
glubean run --pick all --tag currency:EUR  # all EU-currency regions
```

---

## Composing Data Sources

Loaders are plain functions returning `T[]` — compose them freely:

```ts
import { test, fromCsv, fromYaml } from "@glubean/sdk";

const us = await fromCsv("./data/us-routes.csv");
const jp = await fromYaml("./data/jp-routes.yaml");

export const tests = test.each([...us, ...jp])
  ("route-$country-$city", async (ctx, row) => { ... });
```

---

## Filtering Rows

Use `filter` in the test metadata to exclude rows before test generation. Excluded rows never become tests — this is a
hard filter for data cleanup.

```ts
export const tests = test.each(await fromCsv("./data/routes.csv"))
  ({
    id: "route-$country-$city",
    filter: (row) => !!row.endpoint && !!row.expected,
  }, async (ctx, row) => { ... });
```

The filter callback receives `(row, index)` and returns `true` to include.

---

## Auto-Tagging with `tagFields`

Use `tagFields` to automatically tag each test with values from data fields. Tags are generated in `"field:value"`
format.

```ts
export const tests = test.each(await fromCsv("./data/routes.csv"))
  ({
    id: "route-$country-$city",
    tags: "regression",                    // static tag
    tagFields: ["country", "region"],      // → "country:JP", "region:APAC"
    filter: (row) => !!row.endpoint,
  }, async (ctx, row) => { ... });
```

Then filter at runtime without changing code:

```bash
# Only run Japan routes
glubean run --tag country:JP

# Only run APAC region + regression
glubean run --tag region:APAC --tag regression

# Run all
glubean run
```

Both `tags` and `tagFields` accept a single string or an array:

```ts
tags: "smoke"; // same as ["smoke"]
tagFields: "country"; // same as ["country"]
```

---

## Data from Databases or APIs

The SDK does not provide adapters for databases or APIs. Use Deno's top-level `await` with standard libraries to load
data, then pass the result to `test.each()`:

```ts
import { test } from "@glubean/sdk";

// From an API
const res = await fetch("https://test-mgmt.internal/api/cases");
const cases = await res.json();

export const tests = test.each(cases)
  ("case-$id", async (ctx, row) => { ... });
```

**Recommendation**: Export data as JSON or CSV files and commit them to git. This ensures tests are reproducible,
auditable, and don't depend on external services at runtime.

---

## Data Flow

```
Data Sources
  JSON   →  import ... with { type: "json" }    (native)
  CSV    →  fromCsv("./x.csv")
  YAML   →  fromYaml("./x.yaml")
  JSONL  →  fromJsonl("./x.jsonl")
  Dir    →  fromDir("./cases/")                  → T[] (one file = one row)
  Dir    →  fromDir.concat("./batches/")         → T[] (arrays merged)
  Dir    →  fromDir.merge("./regions/")          → Record<string, T>
  DB/API →  user top-level await
         │
         ▼
  test.each(T[])       or       test.pick(Record<string, T>)
    filter:    (row) => boolean       select named examples
    tagFields: "country"              glubean run --pick us-east-1
    tags:      "regression"
         │
         ▼
  N independent tests (each with id, tags, steps)
         │
         ▼
  glubean run --tag country:JP                   runtime filter
```
