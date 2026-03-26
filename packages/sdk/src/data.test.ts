/**
 * Tests for data loading utilities and test.each enhancements.
 */

import { test, expect } from "vitest";
import { fromCsv, fromDir, fromJson, fromJsonl, fromYaml, toArray } from "./data.js";
import { test as gbTest } from "./index.js";
import { clearRegistry, getRegistry } from "./internal.js";
import { loadCsvFromHelper } from "./test-helpers/relative-loader.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const td = (name: string) => resolve(__dirname, "../testdata", name);

// =============================================================================
// toArray() utility
// =============================================================================

test("toArray - undefined returns empty array", () => {
  expect(toArray(undefined)).toEqual([]);
});

test("toArray - string returns single-element array", () => {
  expect(toArray("smoke")).toEqual(["smoke"]);
});

test("toArray - array returns as-is", () => {
  expect(toArray(["smoke", "auth"])).toEqual(["smoke", "auth"]);
});

test("toArray - empty array returns empty array", () => {
  expect(toArray([])).toEqual([]);
});

// =============================================================================
// fromCsv
// =============================================================================

test("fromCsv - loads basic CSV with headers", async () => {
  const data = await fromCsv(td("cases.csv"));
  expect(data.length).toBe(3);
  expect(data[0]).toEqual({ id: "1", country: "US", expected: "200" });
  expect(data[1]).toEqual({ id: "2", country: "JP", expected: "200" });
  expect(data[2]).toEqual({ id: "999", country: "US", expected: "404" });
});

test("fromCsv - bare path resolves relative to project root", async () => {
  const data = await fromCsv("testdata/cases.csv");
  expect(data.length).toBe(3);
  expect(data[0]).toEqual({ id: "1", country: "US", expected: "200" });
});

test("fromCsv - ../ path resolves relative to caller file", async () => {
  const data = await fromCsv("../testdata/cases.csv");
  expect(data.length).toBe(3);
  expect(data[1]).toEqual({ id: "2", country: "JP", expected: "200" });
});

test("fromCsv - helper file resolves relative path from helper location", async () => {
  const data = await loadCsvFromHelper();
  expect(data).toEqual([{ id: "helper-1", country: "SG", expected: "201" }]);
});

test("fromCsv - custom separator (TSV)", async () => {
  const data = await fromCsv(td("cases.tsv"), {
    separator: "\t",
  });
  expect(data.length).toBe(2);
  expect(data[0]).toEqual({ id: "1", country: "US", expected: "200" });
  expect(data[1]).toEqual({ id: "2", country: "JP", expected: "200" });
});

test("fromCsv - handles quoted fields", async () => {
  const data = await fromCsv(td("quoted.csv"));
  expect(data.length).toBe(2);
  expect(data[0].name).toBe("Alice");
  expect(data[0].description).toBe('Has a "nickname"');
  expect(data[0].value).toBe("100");
  expect(data[1].name).toBe("Bob");
});

test("fromCsv - without headers uses numeric keys", async () => {
  const data = await fromCsv(td("cases.csv"), {
    headers: false,
  });
  // First "row" is actually the header line
  expect(data[0]).toEqual({ "0": "id", "1": "country", "2": "expected" });
  expect(data[1]).toEqual({ "0": "1", "1": "US", "2": "200" });
});

test("fromCsv - empty file returns empty array", async () => {
  // Create a temp empty file
  const tempDir = await mkdtemp(join(tmpdir(), "sdk-"));
  const tempPath = join(tempDir, "temp.csv");
  try {
    await writeFile(tempPath, "", "utf-8");
    const data = await fromCsv(tempPath);
    expect(data.length).toBe(0);
  } finally {
    await rm(tempPath);
  }
});

test("fromCsv - nonexistent file throws", async () => {
  await expect(
    () => fromCsv("./nonexistent.csv"),
  ).rejects.toThrow("Failed to read file");
});

test("fromCsv - nonexistent file error includes path context", async () => {
  await expect(
    () => fromCsv("./nonexistent.csv"),
  ).rejects.toThrow("Current working directory:");
  await expect(
    () => fromCsv("./nonexistent.csv"),
  ).rejects.toThrow("Resolved path:");
  await expect(
    () => fromCsv("./nonexistent.csv"),
  ).rejects.toThrow(
    'Hint: paths starting with "./" or "../" are resolved relative to the calling file.',
  );
});

test("fromDir - nonexistent directory error includes path context", async () => {
  await expect(
    () => fromDir("./missing-data-dir"),
  ).rejects.toThrow("Failed to read directory");
  await expect(
    () => fromDir("./missing-data-dir"),
  ).rejects.toThrow("Resolved path:");
});

test("fromDir.concat - malformed JSON includes path context", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdk-bad-json-"));
  try {
    await writeFile(`${tempDir}/invalid.json`, "{ bad json", "utf-8");
    await expect(
      () => fromDir.concat(tempDir),
    ).rejects.toThrow("Failed to parse JSON file");
    await expect(
      () => fromDir.concat(tempDir),
    ).rejects.toThrow("Current working directory:");
    await expect(
      () => fromDir.concat(tempDir),
    ).rejects.toThrow("Resolved path:");
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

// =============================================================================
// fromYaml
// =============================================================================

test("fromYaml - loads top-level array", async () => {
  const data = await fromYaml(td("cases.yaml"));
  expect(data.length).toBe(3);
  expect(data[0]).toEqual({ id: 1, country: "US", expected: 200 });
  expect(data[1]).toEqual({ id: 2, country: "JP", expected: 200 });
});

test("fromYaml - ../ path resolves relative to caller file", async () => {
  const data = await fromYaml("../testdata/cases.yaml");
  expect(data.length).toBe(3);
  expect(data[0]).toEqual({ id: 1, country: "US", expected: 200 });
});

test("fromYaml - loads nested array with pick", async () => {
  const data = await fromYaml(td("nested.yaml"), {
    pick: "testCases",
  });
  expect(data.length).toBe(2);
  expect(data[0]).toEqual({ id: 1, expected: 200 });
  expect(data[1]).toEqual({ id: 2, expected: 404 });
});

test("fromYaml - throws on non-array root without pick", async () => {
  await expect(
    () => fromYaml(td("nested.yaml")),
  ).rejects.toThrow("root is an object, not an array");
});

test("fromYaml - throws on invalid pick path", async () => {
  await expect(
    () =>
      fromYaml(td("nested.yaml"), {
        pick: "nonexistent.path",
      }),
  ).rejects.toThrow('pick path "nonexistent.path" did not resolve to an array');
});

test(
  "fromYaml - error message suggests available array fields",
  async () => {
    try {
      await fromYaml(td("nested.yaml"));
      throw new Error("Should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      // Should mention the "testCases" array field
      expect(msg.includes("testCases")).toBe(true);
      expect(msg.includes("Hint")).toBe(true);
    }
  },
);

// =============================================================================
// fromJsonl
// =============================================================================

test("fromJsonl - loads JSONL file", async () => {
  const data = await fromJsonl(td("requests.jsonl"));
  expect(data.length).toBe(3);
  expect(data[0]).toEqual({ method: "GET", url: "/users/1", expected: 200 });
  expect(data[2]).toEqual({ method: "POST", url: "/users", expected: 201 });
});

test("fromJsonl - handles trailing empty lines", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdk-"));
  const tempPath = join(tempDir, "temp.jsonl");
  try {
    await writeFile(tempPath, '{"a":1}\n{"a":2}\n\n', "utf-8");
    const data = await fromJsonl(tempPath);
    expect(data.length).toBe(2);
  } finally {
    await rm(tempPath);
  }
});

test("fromJsonl - throws on invalid JSON line", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdk-"));
  const tempPath = join(tempDir, "temp.jsonl");
  try {
    await writeFile(tempPath, '{"a":1}\nnot json\n', "utf-8");
    await expect(
      () => fromJsonl(tempPath),
    ).rejects.toThrow("invalid JSON at line 2");
  } finally {
    await rm(tempPath);
  }
});

// =============================================================================
// fromDir
// =============================================================================

test("fromDir - default mode: one file = one row", async () => {
  const data = await fromDir(td("cases-dir/"));
  expect(data.length).toBe(2);

  // Sort by _name for deterministic order
  data.sort((a, b) => String(a._name).localeCompare(String(b._name)));

  expect(data[0]._name).toBe("user-1");
  expect(data[0].id).toBe(1);
  expect(data[0].country).toBe("US");

  expect(data[1]._name).toBe("user-999");
  expect(data[1].id).toBe(999);
  expect(data[1].country).toBe("JP");
});

test("fromDir - bare path resolves relative to project root", async () => {
  const data = await fromDir("testdata/cases-dir/");
  expect(data.length).toBe(2);
  const names = data.map((row) => row._name).sort();
  expect(names).toEqual(["user-1", "user-999"]);
});

test("fromDir - default mode injects _name and _path", async () => {
  const data = await fromDir(td("cases-dir/"));
  for (const row of data) {
    expect(typeof row._name).toBe("string");
    expect(typeof row._path).toBe("string");
    expect((row._name as string).length > 0).toBe(true);
  }
});

test("fromDir.concat - concatenates arrays from files", async () => {
  const data = await fromDir.concat(td("batches-dir/"));
  expect(data.length).toBe(4);
  // batch-001.json has ids 1,2; batch-002.json has ids 3,4
  const ids = data.map((r) => r.id);
  expect(ids).toEqual(expect.arrayContaining([1, 2, 3, 4]));
});

test("fromDir - ext filter works", async () => {
  // Only .yaml files (there are none in cases-dir)
  const data = await fromDir(td("cases-dir/"), {
    ext: ".yaml",
  });
  expect(data.length).toBe(0);
});

test("fromDir - ext accepts string", async () => {
  const data = await fromDir(td("cases-dir/"), {
    ext: ".json",
  });
  expect(data.length).toBe(2);
});

test("fromDir - empty directory returns empty array", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdk-"));
  try {
    const data = await fromDir(tempDir);
    expect(data.length).toBe(0);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

// =============================================================================
// fromDir.merge
// =============================================================================

test("fromDir.merge - merges objects from multiple files", async () => {
  const data = await fromDir.merge(td("regions-dir/"));

  // eu-west.json has 2 keys, us-east.json has 2 keys → 4 total
  expect(Object.keys(data).length).toBe(4);
  expect(typeof data["eu-west-1"]).toBe("object");
  expect(typeof data["us-east-1"]).toBe("object");
  expect((data["eu-west-1"] as Record<string, unknown>).currency).toBe("EUR");
  expect((data["us-east-1"] as Record<string, unknown>).currency).toBe("USD");
});

test("fromDir.merge - preserves all keys", async () => {
  const data = await fromDir.merge(td("regions-dir/"));

  const keys = Object.keys(data).sort();
  expect(keys).toEqual(["eu-west-1", "eu-west-2", "us-east-1", "us-east-2"]);
});

test("fromDir.merge - empty directory returns empty object", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "sdk-"));
  try {
    const data = await fromDir.merge(tempDir);
    expect(Object.keys(data).length).toBe(0);
  } finally {
    await rm(tempDir, { recursive: true });
  }
});

test(
  "fromDir.merge - later files override earlier (alphabetical)",
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sdk-"));
    try {
      // a-first.json and b-second.json both have key "shared"
      await writeFile(
        `${tempDir}/a-first.json`,
        JSON.stringify({ shared: { from: "a" }, "a-only": { v: 1 } }),
        "utf-8",
      );
      await writeFile(
        `${tempDir}/b-second.json`,
        JSON.stringify({ shared: { from: "b" }, "b-only": { v: 2 } }),
        "utf-8",
      );

      const data = await fromDir.merge(tempDir);

      // "shared" should come from b-second (later alphabetically)
      expect((data["shared"] as Record<string, unknown>).from).toBe("b");
      expect(typeof data["a-only"]).toBe("object");
      expect(typeof data["b-only"]).toBe("object");
    } finally {
      await rm(tempDir, { recursive: true });
    }
  },
);

// =============================================================================
// fromYaml.map
// =============================================================================

test("fromYaml.map - loads top-level object", async () => {
  const data = await fromYaml.map(td("scenarios.yaml"));
  expect(Object.keys(data).sort()).toEqual(["edge", "missing", "normal"]);
  expect(data["normal"]).toEqual({ q: "hello", expected: 200 });
  expect(data["edge"]).toEqual({ q: "", expected: 400 });
});

test("fromYaml.map - throws on array root", async () => {
  await expect(
    () => fromYaml.map(td("cases.yaml")),
  ).rejects.toThrow("expected a top-level object for fromYaml.map()");
});

// =============================================================================
// fromJson
// =============================================================================

test("fromJson - loads top-level array", async () => {
  const data = await fromJson(td("cases.json"));
  expect(data.length).toBe(3);
  expect(data[0]).toEqual({ id: 1, country: "US", expected: 200 });
});

test("fromJson - loads nested array with pick", async () => {
  const data = await fromJson(td("nested.json"), { pick: "requests" });
  expect(data.length).toBe(2);
  expect(data[0]).toEqual({ method: "GET", url: "/users/1", expected: 200 });
});

test("fromJson - throws on non-array root without pick", async () => {
  await expect(
    () => fromJson(td("nested.json")),
  ).rejects.toThrow("root is an object, not an array");
});

test("fromJson - nonexistent file throws with context", async () => {
  await expect(
    () => fromJson("./nonexistent.json"),
  ).rejects.toThrow("Failed to read file");
});

// =============================================================================
// fromJson.map
// =============================================================================

test("fromJson.map - loads top-level object", async () => {
  const data = await fromJson.map(td("scenarios.json"));
  expect(Object.keys(data).sort()).toEqual(["edge", "missing", "normal"]);
  expect(data["normal"]).toEqual({ q: "hello", expected: 200 });
});

test("fromJson.map - throws on array root", async () => {
  await expect(
    () => fromJson.map(td("cases.json")),
  ).rejects.toThrow("expected a top-level object for fromJson.map()");
});

// =============================================================================
// test.each - filter callback
// =============================================================================

test("test.each - filter excludes rows", () => {
  clearRegistry();
  const tests = gbTest.each([
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

  expect(tests.length).toBe(1);
  expect(tests[0].meta.id).toBe("user-2");

  const registry = getRegistry();
  expect(registry.length).toBe(1);
  expect(registry[0].id).toBe("user-2");
});

test("test.each - filter receives index", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1 }, { id: 2 }, { id: 3 }])(
    {
      id: "item-$id",
      filter: (_row, index) => index < 2,
    },
    async (_ctx, _data) => {},
  );

  expect(tests.length).toBe(2);
  expect(tests[0].meta.id).toBe("item-1");
  expect(tests[1].meta.id).toBe("item-2");
});

test("test.each - filter with all excluded returns empty", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1 }, { id: 2 }])(
    {
      id: "item-$id",
      filter: () => false,
    },
    async (_ctx, _data) => {},
  );

  expect(tests.length).toBe(0);
  expect(getRegistry().length).toBe(0);
});

// =============================================================================
// test.each - tagFields
// =============================================================================

test("test.each - tagFields generates key:value tags", () => {
  clearRegistry();
  const tests = gbTest.each([
    { id: 1, country: "US", region: "NA" },
    { id: 2, country: "JP", region: "APAC" },
  ])(
    {
      id: "user-$id",
      tagFields: ["country", "region"],
    },
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.tags).toEqual(["country:US", "region:NA"]);
  expect(tests[1].meta.tags).toEqual(["country:JP", "region:APAC"]);

  const registry = getRegistry();
  expect(registry[0].tags).toEqual(["country:US", "region:NA"]);
  expect(registry[1].tags).toEqual(["country:JP", "region:APAC"]);
});

test("test.each - tagFields accepts single string", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1, country: "US" }])(
    {
      id: "user-$id",
      tagFields: "country",
    },
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.tags).toEqual(["country:US"]);
});

test("test.each - tagFields combined with static tags", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1, country: "JP" }])(
    {
      id: "user-$id",
      tags: ["regression", "smoke"],
      tagFields: "country",
    },
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.tags).toEqual(["regression", "smoke", "country:JP"]);
});

test("test.each - tagFields skips null/undefined values", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1, country: undefined as unknown as string }])(
    {
      id: "user-$id",
      tagFields: ["country", "region"],
    },
    async (_ctx, _data) => {},
  );

  // country is undefined, region doesn't exist → no tags
  expect(tests[0].meta.tags).toEqual(undefined);
});

// =============================================================================
// test.each - string | string[] tags normalization
// =============================================================================

test("test.each - tags accepts single string", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1 }])(
    { id: "item-$id", tags: "smoke" },
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.tags).toEqual(["smoke"]);
});

test("test.each - tags accepts array", () => {
  clearRegistry();
  const tests = gbTest.each([{ id: 1 }])(
    { id: "item-$id", tags: ["smoke", "auth"] },
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.tags).toEqual(["smoke", "auth"]);
});

test("test() quick mode - tags accepts single string", () => {
  clearRegistry();
  gbTest({ id: "my-test", tags: "smoke" }, async (_ctx) => {});

  const registry = getRegistry();
  expect(registry[0].tags).toEqual(["smoke"]);
});

// =============================================================================
// EachBuilder - filter and tagFields
// =============================================================================

test("EachBuilder - filter works in builder mode", () => {
  clearRegistry();
  const builder = gbTest.each([
    { id: 1, country: "US" },
    { id: 2, country: "JP" },
    { id: 3, country: "US" },
  ])({
    id: "item-$id",
    filter: (row) => row.country === "JP",
  });

  const tests = builder.build();
  expect(tests.length).toBe(1);
  expect(tests[0].meta.id).toBe("item-2");
});

test("EachBuilder - tagFields works in builder mode", () => {
  clearRegistry();
  const builder = gbTest.each([
    { id: 1, country: "US" },
    { id: 2, country: "JP" },
  ])({
    id: "item-$id",
    tags: "regression",
    tagFields: "country",
  });

  const tests = builder.build();
  expect(tests[0].meta.tags).toEqual(["regression", "country:US"]);
  expect(tests[1].meta.tags).toEqual(["regression", "country:JP"]);
});

test("EachBuilder - filter + tagFields combined", () => {
  clearRegistry();
  const builder = gbTest.each([
    { id: 1, country: "US" },
    { id: 2, country: "JP" },
    { id: 3, country: "DE" },
  ])({
    id: "item-$id",
    filter: (row) => row.country !== "DE",
    tagFields: "country",
  });

  const tests = builder.build();
  expect(tests.length).toBe(2);
  expect(tests[0].meta.tags).toEqual(["country:US"]);
  expect(tests[1].meta.tags).toEqual(["country:JP"]);

  const registry = getRegistry();
  expect(registry.length).toBe(2);
});
