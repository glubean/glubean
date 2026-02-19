/**
 * Tests for data loading utilities and test.each enhancements.
 */

import { assertArrayIncludes, assertEquals, assertRejects } from "@std/assert";
import { fromCsv, fromDir, fromJsonl, fromYaml, toArray } from "./data.ts";
import { test } from "./mod.ts";
import { clearRegistry, getRegistry } from "./internal.ts";

// =============================================================================
// toArray() utility
// =============================================================================

Deno.test("toArray - undefined returns empty array", () => {
  assertEquals(toArray(undefined), []);
});

Deno.test("toArray - string returns single-element array", () => {
  assertEquals(toArray("smoke"), ["smoke"]);
});

Deno.test("toArray - array returns as-is", () => {
  assertEquals(toArray(["smoke", "auth"]), ["smoke", "auth"]);
});

Deno.test("toArray - empty array returns empty array", () => {
  assertEquals(toArray([]), []);
});

// =============================================================================
// fromCsv
// =============================================================================

Deno.test("fromCsv - loads basic CSV with headers", async () => {
  const data = await fromCsv("./packages/sdk/testdata/cases.csv");
  assertEquals(data.length, 3);
  assertEquals(data[0], { id: "1", country: "US", expected: "200" });
  assertEquals(data[1], { id: "2", country: "JP", expected: "200" });
  assertEquals(data[2], { id: "999", country: "US", expected: "404" });
});

Deno.test("fromCsv - custom separator (TSV)", async () => {
  const data = await fromCsv("./packages/sdk/testdata/cases.tsv", {
    separator: "\t",
  });
  assertEquals(data.length, 2);
  assertEquals(data[0], { id: "1", country: "US", expected: "200" });
  assertEquals(data[1], { id: "2", country: "JP", expected: "200" });
});

Deno.test("fromCsv - handles quoted fields", async () => {
  const data = await fromCsv("./packages/sdk/testdata/quoted.csv");
  assertEquals(data.length, 2);
  assertEquals(data[0].name, "Alice");
  assertEquals(data[0].description, 'Has a "nickname"');
  assertEquals(data[0].value, "100");
  assertEquals(data[1].name, "Bob");
});

Deno.test("fromCsv - without headers uses numeric keys", async () => {
  const data = await fromCsv("./packages/sdk/testdata/cases.csv", {
    headers: false,
  });
  // First "row" is actually the header line
  assertEquals(data[0], { "0": "id", "1": "country", "2": "expected" });
  assertEquals(data[1], { "0": "1", "1": "US", "2": "200" });
});

Deno.test("fromCsv - empty file returns empty array", async () => {
  // Create a temp empty file
  const tempPath = await Deno.makeTempFile({ suffix: ".csv" });
  try {
    await Deno.writeTextFile(tempPath, "");
    const data = await fromCsv(tempPath);
    assertEquals(data.length, 0);
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("fromCsv - nonexistent file throws", async () => {
  await assertRejects(
    () => fromCsv("./nonexistent.csv"),
    Error,
    "Failed to read file",
  );
});

Deno.test("fromCsv - nonexistent file error includes path context", async () => {
  await assertRejects(
    () => fromCsv("./nonexistent.csv"),
    Error,
    "Current working directory:",
  );
  await assertRejects(
    () => fromCsv("./nonexistent.csv"),
    Error,
    "Resolved path:",
  );
  await assertRejects(
    () => fromCsv("./nonexistent.csv"),
    Error,
    'Hint: data loader paths are resolved from project root',
  );
});

Deno.test("fromDir - nonexistent directory error includes path context", async () => {
  await assertRejects(
    () => fromDir("./missing-data-dir"),
    Error,
    "Failed to read directory",
  );
  await assertRejects(
    () => fromDir("./missing-data-dir"),
    Error,
    "Resolved path:",
  );
});

Deno.test("fromDir.concat - malformed JSON includes path context", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "sdk-bad-json-" });
  try {
    await Deno.writeTextFile(`${tempDir}/invalid.json`, "{ bad json");
    await assertRejects(
      () => fromDir.concat(tempDir),
      Error,
      "Failed to parse JSON file",
    );
    await assertRejects(
      () => fromDir.concat(tempDir),
      Error,
      "Current working directory:",
    );
    await assertRejects(
      () => fromDir.concat(tempDir),
      Error,
      "Resolved path:",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// fromYaml
// =============================================================================

Deno.test("fromYaml - loads top-level array", async () => {
  const data = await fromYaml("./packages/sdk/testdata/cases.yaml");
  assertEquals(data.length, 3);
  assertEquals(data[0], { id: 1, country: "US", expected: 200 });
  assertEquals(data[1], { id: 2, country: "JP", expected: 200 });
});

Deno.test("fromYaml - loads nested array with pick", async () => {
  const data = await fromYaml("./packages/sdk/testdata/nested.yaml", {
    pick: "testCases",
  });
  assertEquals(data.length, 2);
  assertEquals(data[0], { id: 1, expected: 200 });
  assertEquals(data[1], { id: 2, expected: 404 });
});

Deno.test("fromYaml - throws on non-array root without pick", async () => {
  await assertRejects(
    () => fromYaml("./packages/sdk/testdata/nested.yaml"),
    Error,
    "root is an object, not an array",
  );
});

Deno.test("fromYaml - throws on invalid pick path", async () => {
  await assertRejects(
    () =>
      fromYaml("./packages/sdk/testdata/nested.yaml", {
        pick: "nonexistent.path",
      }),
    Error,
    'pick path "nonexistent.path" did not resolve to an array',
  );
});

Deno.test(
  "fromYaml - error message suggests available array fields",
  async () => {
    try {
      await fromYaml("./packages/sdk/testdata/nested.yaml");
      throw new Error("Should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      // Should mention the "testCases" array field
      assertEquals(msg.includes("testCases"), true);
      assertEquals(msg.includes("Hint"), true);
    }
  },
);

// =============================================================================
// fromJsonl
// =============================================================================

Deno.test("fromJsonl - loads JSONL file", async () => {
  const data = await fromJsonl("./packages/sdk/testdata/requests.jsonl");
  assertEquals(data.length, 3);
  assertEquals(data[0], { method: "GET", url: "/users/1", expected: 200 });
  assertEquals(data[2], { method: "POST", url: "/users", expected: 201 });
});

Deno.test("fromJsonl - handles trailing empty lines", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(tempPath, '{"a":1}\n{"a":2}\n\n');
    const data = await fromJsonl(tempPath);
    assertEquals(data.length, 2);
  } finally {
    await Deno.remove(tempPath);
  }
});

Deno.test("fromJsonl - throws on invalid JSON line", async () => {
  const tempPath = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(tempPath, '{"a":1}\nnot json\n');
    await assertRejects(
      () => fromJsonl(tempPath),
      Error,
      "invalid JSON at line 2",
    );
  } finally {
    await Deno.remove(tempPath);
  }
});

// =============================================================================
// fromDir
// =============================================================================

Deno.test("fromDir - default mode: one file = one row", async () => {
  const data = await fromDir("./packages/sdk/testdata/cases-dir/");
  assertEquals(data.length, 2);

  // Sort by _name for deterministic order
  data.sort((a, b) => String(a._name).localeCompare(String(b._name)));

  assertEquals(data[0]._name, "user-1");
  assertEquals(data[0].id, 1);
  assertEquals(data[0].country, "US");

  assertEquals(data[1]._name, "user-999");
  assertEquals(data[1].id, 999);
  assertEquals(data[1].country, "JP");
});

Deno.test("fromDir - default mode injects _name and _path", async () => {
  const data = await fromDir("./packages/sdk/testdata/cases-dir/");
  for (const row of data) {
    assertEquals(typeof row._name, "string");
    assertEquals(typeof row._path, "string");
    assertEquals((row._name as string).length > 0, true);
  }
});

Deno.test("fromDir.concat - concatenates arrays from files", async () => {
  const data = await fromDir.concat("./packages/sdk/testdata/batches-dir/");
  assertEquals(data.length, 4);
  // batch-001.json has ids 1,2; batch-002.json has ids 3,4
  const ids = data.map((r) => r.id);
  assertArrayIncludes(ids, [1, 2, 3, 4]);
});

Deno.test("fromDir - ext filter works", async () => {
  // Only .yaml files (there are none in cases-dir)
  const data = await fromDir("./packages/sdk/testdata/cases-dir/", {
    ext: ".yaml",
  });
  assertEquals(data.length, 0);
});

Deno.test("fromDir - ext accepts string", async () => {
  const data = await fromDir("./packages/sdk/testdata/cases-dir/", {
    ext: ".json",
  });
  assertEquals(data.length, 2);
});

Deno.test("fromDir - empty directory returns empty array", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const data = await fromDir(tempDir);
    assertEquals(data.length, 0);
  } finally {
    await Deno.remove(tempDir);
  }
});

// =============================================================================
// fromDir.merge
// =============================================================================

Deno.test("fromDir.merge - merges objects from multiple files", async () => {
  const data = await fromDir.merge("./packages/sdk/testdata/regions-dir/");

  // eu-west.json has 2 keys, us-east.json has 2 keys → 4 total
  assertEquals(Object.keys(data).length, 4);
  assertEquals(typeof data["eu-west-1"], "object");
  assertEquals(typeof data["us-east-1"], "object");
  assertEquals((data["eu-west-1"] as Record<string, unknown>).currency, "EUR");
  assertEquals((data["us-east-1"] as Record<string, unknown>).currency, "USD");
});

Deno.test("fromDir.merge - preserves all keys", async () => {
  const data = await fromDir.merge("./packages/sdk/testdata/regions-dir/");

  const keys = Object.keys(data).sort();
  assertEquals(keys, ["eu-west-1", "eu-west-2", "us-east-1", "us-east-2"]);
});

Deno.test("fromDir.merge - empty directory returns empty object", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const data = await fromDir.merge(tempDir);
    assertEquals(Object.keys(data).length, 0);
  } finally {
    await Deno.remove(tempDir);
  }
});

Deno.test(
  "fromDir.merge - later files override earlier (alphabetical)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      // a-first.json and b-second.json both have key "shared"
      await Deno.writeTextFile(
        `${tempDir}/a-first.json`,
        JSON.stringify({ shared: { from: "a" }, "a-only": { v: 1 } }),
      );
      await Deno.writeTextFile(
        `${tempDir}/b-second.json`,
        JSON.stringify({ shared: { from: "b" }, "b-only": { v: 2 } }),
      );

      const data = await fromDir.merge(tempDir);

      // "shared" should come from b-second (later alphabetically)
      assertEquals((data["shared"] as Record<string, unknown>).from, "b");
      assertEquals(typeof data["a-only"], "object");
      assertEquals(typeof data["b-only"], "object");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// =============================================================================
// test.each - filter callback
// =============================================================================

Deno.test("test.each - filter excludes rows", () => {
  clearRegistry();
  const tests = test.each([
    { id: 1, country: "US", expected: 200 },
    { id: 2, country: "JP", expected: 200 },
    { id: 999, country: "US", expected: 404 },
  ])(
    {
      id: "user-$id",
      filter: (row) => row.country === "JP",
    },
    async (_ctx, _data) => {},
  );

  assertEquals(tests.length, 1);
  assertEquals(tests[0].meta.id, "user-2");

  const registry = getRegistry();
  assertEquals(registry.length, 1);
  assertEquals(registry[0].id, "user-2");
});

Deno.test("test.each - filter receives index", () => {
  clearRegistry();
  const tests = test.each([{ id: 1 }, { id: 2 }, { id: 3 }])(
    {
      id: "item-$id",
      filter: (_row, index) => index < 2,
    },
    async (_ctx, _data) => {},
  );

  assertEquals(tests.length, 2);
  assertEquals(tests[0].meta.id, "item-1");
  assertEquals(tests[1].meta.id, "item-2");
});

Deno.test("test.each - filter with all excluded returns empty", () => {
  clearRegistry();
  const tests = test.each([{ id: 1 }, { id: 2 }])(
    {
      id: "item-$id",
      filter: () => false,
    },
    async (_ctx, _data) => {},
  );

  assertEquals(tests.length, 0);
  assertEquals(getRegistry().length, 0);
});

// =============================================================================
// test.each - tagFields
// =============================================================================

Deno.test("test.each - tagFields generates key:value tags", () => {
  clearRegistry();
  const tests = test.each([
    { id: 1, country: "US", region: "NA" },
    { id: 2, country: "JP", region: "APAC" },
  ])(
    {
      id: "user-$id",
      tagFields: ["country", "region"],
    },
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.tags, ["country:US", "region:NA"]);
  assertEquals(tests[1].meta.tags, ["country:JP", "region:APAC"]);

  const registry = getRegistry();
  assertEquals(registry[0].tags, ["country:US", "region:NA"]);
  assertEquals(registry[1].tags, ["country:JP", "region:APAC"]);
});

Deno.test("test.each - tagFields accepts single string", () => {
  clearRegistry();
  const tests = test.each([{ id: 1, country: "US" }])(
    {
      id: "user-$id",
      tagFields: "country",
    },
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.tags, ["country:US"]);
});

Deno.test("test.each - tagFields combined with static tags", () => {
  clearRegistry();
  const tests = test.each([{ id: 1, country: "JP" }])(
    {
      id: "user-$id",
      tags: ["regression", "smoke"],
      tagFields: "country",
    },
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.tags, ["regression", "smoke", "country:JP"]);
});

Deno.test("test.each - tagFields skips null/undefined values", () => {
  clearRegistry();
  const tests = test.each([{ id: 1, country: undefined as unknown as string }])(
    {
      id: "user-$id",
      tagFields: ["country", "region"],
    },
    async (_ctx, _data) => {},
  );

  // country is undefined, region doesn't exist → no tags
  assertEquals(tests[0].meta.tags, undefined);
});

// =============================================================================
// test.each - string | string[] tags normalization
// =============================================================================

Deno.test("test.each - tags accepts single string", () => {
  clearRegistry();
  const tests = test.each([{ id: 1 }])(
    { id: "item-$id", tags: "smoke" },
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.tags, ["smoke"]);
});

Deno.test("test.each - tags accepts array", () => {
  clearRegistry();
  const tests = test.each([{ id: 1 }])(
    { id: "item-$id", tags: ["smoke", "auth"] },
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.tags, ["smoke", "auth"]);
});

Deno.test("test() quick mode - tags accepts single string", () => {
  clearRegistry();
  test({ id: "my-test", tags: "smoke" }, async (_ctx) => {});

  const registry = getRegistry();
  assertEquals(registry[0].tags, ["smoke"]);
});

// =============================================================================
// EachBuilder - filter and tagFields
// =============================================================================

Deno.test("EachBuilder - filter works in builder mode", () => {
  clearRegistry();
  const builder = test.each([
    { id: 1, country: "US" },
    { id: 2, country: "JP" },
    { id: 3, country: "US" },
  ])({
    id: "item-$id",
    filter: (row) => row.country === "JP",
  });

  const tests = builder.build();
  assertEquals(tests.length, 1);
  assertEquals(tests[0].meta.id, "item-2");
});

Deno.test("EachBuilder - tagFields works in builder mode", () => {
  clearRegistry();
  const builder = test.each([
    { id: 1, country: "US" },
    { id: 2, country: "JP" },
  ])({
    id: "item-$id",
    tags: "regression",
    tagFields: "country",
  });

  const tests = builder.build();
  assertEquals(tests[0].meta.tags, ["regression", "country:US"]);
  assertEquals(tests[1].meta.tags, ["regression", "country:JP"]);
});

Deno.test("EachBuilder - filter + tagFields combined", () => {
  clearRegistry();
  const builder = test.each([
    { id: 1, country: "US" },
    { id: 2, country: "JP" },
    { id: 3, country: "DE" },
  ])({
    id: "item-$id",
    filter: (row) => row.country !== "DE",
    tagFields: "country",
  });

  const tests = builder.build();
  assertEquals(tests.length, 2);
  assertEquals(tests[0].meta.tags, ["country:US"]);
  assertEquals(tests[1].meta.tags, ["country:JP"]);

  const registry = getRegistry();
  assertEquals(registry.length, 2);
});
