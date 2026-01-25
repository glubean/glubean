# Data Loading for Data-Driven Tests

This guide covers how to load test data from files and directories for use with
`test.each()`.

## Quick Reference

| Data Format   | Recommended Approach                       |
| ------------- | ------------------------------------------ |
| **JSON**      | Native `import` — no SDK helper needed     |
| **CSV**       | `fromCsv("./data.csv")`                    |
| **YAML**      | `fromYaml("./data.yaml")`                  |
| **JSONL**     | `fromJsonl("./data.jsonl")`                |
| **Directory** | `fromDir("./cases/")`                      |
| **DB / API**  | User top-level `await` + `test.each(rows)` |

All file paths are **relative to the project root** (the directory containing
`deno.json`).

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
  }
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

If the root is an object and no `pick` is provided, the SDK throws a helpful
error listing discovered array fields:

```
Error: ./data/collection.yaml: root is an object, not an array.
Found these array fields: "testCases" (2 items)
Hint: use { pick: "testCases" } to select one.
```

---

## JSONL (JSON Lines)

Each line is a standalone JSON object. Useful for log-style data or streaming
exports.

```ts
import { fromJsonl, test } from "@glubean/sdk";

export const tests = test.each(await fromJsonl("./data/requests.jsonl"))(
  "req-$index",
  async (ctx, row) => {
    const res = await ctx.http[row.method.toLowerCase()](
      `${baseUrl}${row.url}`
    );
    ctx.assert(res.status === row.expected, "status check");
  }
);
```

---

## Directory of Files

### Default Mode — One File Per Test

Each file becomes one row in the data table. The file contents are spread into
the row, plus `_name` (filename without extension) and `_path` (relative path)
are auto-injected.

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
  }
);
```

### Concat Mode — Multiple Slices Into One Table

Each file contains an array. All arrays are concatenated into one flat table.

```
batches/
  batch-001.json → [{ id: 1, ... }, { id: 2, ... }]
  batch-002.json → [{ id: 3, ... }, { id: 4, ... }]
```

```ts
export const tests = test.each(
  await fromDir("./batches/", { concat: true })
)("case-$id", async (ctx, row) => { ... });
```

### Options

| Option      | Type                 | Default   | Description                                    |
| ----------- | -------------------- | --------- | ---------------------------------------------- |
| `ext`       | `string \| string[]` | `".json"` | File extensions to include                     |
| `concat`    | `boolean`            | `false`   | Concatenate arrays from all files              |
| `pick`      | `string`             | —         | Dot-path to array inside each file (JSON/YAML) |
| `recursive` | `boolean`            | `false`   | Recurse into subdirectories                    |

```ts
// YAML directory with pick
const data = await fromDir("./specs/", {
  ext: ".yaml",
  pick: "cases",
  concat: true,
});

// Multiple file types
const data = await fromDir("./data/", {
  ext: [".json", ".yaml"],
});
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

Use `filter` in the test metadata to exclude rows before test generation.
Excluded rows never become tests — this is a hard filter for data cleanup.

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

Use `tagFields` to automatically tag each test with values from data fields.
Tags are generated in `"field:value"` format.

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

The SDK does not provide adapters for databases or APIs. Use Deno's top-level
`await` with standard libraries to load data, then pass the result to
`test.each()`:

```ts
import { test } from "@glubean/sdk";

// From an API
const res = await fetch("https://test-mgmt.internal/api/cases");
const cases = await res.json();

export const tests = test.each(cases)
  ("case-$id", async (ctx, row) => { ... });
```

**Recommendation**: Export data as JSON or CSV files and commit them to git.
This ensures tests are reproducible, auditable, and don't depend on external
services at runtime.

---

## Data Flow

```
Data Sources
  JSON   →  import ... with { type: "json" }    (native)
  CSV    →  fromCsv("./x.csv")
  YAML   →  fromYaml("./x.yaml")
  JSONL  →  fromJsonl("./x.jsonl")
  Dir    →  fromDir("./cases/")
  DB/API →  user top-level await
         │
         ▼
     T[] (array)
         │
         ▼
  test.each(data)
    filter:    (row) => boolean                  hard exclude
    tagFields: "country"                         auto "country:JP" tags
    tags:      "regression"                      static tags
         │
         ▼
  N independent tests (each with id, tags, steps)
         │
         ▼
  glubean run --tag country:JP                   runtime filter
```
