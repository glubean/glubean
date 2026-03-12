import { test, expect } from "vitest";
import { isSpecVersionSupported, Scanner, SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } from "./index.js";
import { nodeFs, nodeHasher } from "./fs.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const emptyExtractor = () => Promise.resolve([]);

// ==================== Spec Version Tests ====================

test("SPEC_VERSION is 2.0", () => {
  expect(typeof SPEC_VERSION).toBe("string");
  expect(SPEC_VERSION).toBe("2.0");
});

test("SUPPORTED_SPEC_VERSIONS includes current and legacy versions", () => {
  expect(SUPPORTED_SPEC_VERSIONS.includes("1.0")).toBe(true);
  expect(SUPPORTED_SPEC_VERSIONS.includes("2.0")).toBe(true);
});

test("isSpecVersionSupported returns true for supported versions", () => {
  expect(isSpecVersionSupported("1.0")).toBe(true);
  expect(isSpecVersionSupported("2.0")).toBe(true);
});

test("isSpecVersionSupported returns false for unsupported versions", () => {
  expect(isSpecVersionSupported("0.5")).toBe(false);
  expect(isSpecVersionSupported("3.0")).toBe(false);
  expect(isSpecVersionSupported("invalid")).toBe(false);
});

// ==================== Scanner Tests ====================

test("Scanner constructor validates spec version", () => {
  // Valid versions
  const scanner1 = new Scanner(nodeFs, nodeHasher, "1.0", emptyExtractor);
  expect(scanner1).toBeDefined();

  const scanner2 = new Scanner(nodeFs, nodeHasher, "2.0", emptyExtractor);
  expect(scanner2).toBeDefined();

  // Invalid version
  expect(() => {
    new Scanner(nodeFs, nodeHasher, "invalid", emptyExtractor);
  }).toThrow();
});

test("Scanner defaults to current spec version", () => {
  const scanner = new Scanner(nodeFs, nodeHasher, SPEC_VERSION, emptyExtractor);
  expect(scanner).toBeDefined();
});

// ==================== Validation Tests ====================

test("Scanner.validate returns warnings for missing package.json", async () => {
  const mockFs = {
    ...nodeFs,
    exists: (_path: string) => Promise.resolve(false),
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      // Empty directory - yield nothing
    },
  };

  const mockScanner = new Scanner(
    mockFs,
    nodeHasher,
    SPEC_VERSION,
    emptyExtractor,
  );
  const result = await mockScanner.validate("/fake/dir");

  expect(result.valid).toBe(false);
  expect(result.warnings.length > 0).toBe(true);
  expect(
    result.warnings.some((w) => w.includes("package.json")),
  ).toBe(true);
});

test("Scanner.validate succeeds when .test.ts exists", async () => {
  const mockFs = {
    ...nodeFs,
    exists: (path: string) => Promise.resolve(path.endsWith("package.json")),
    readText: (path: string) => {
      if (path.endsWith("package.json")) {
        return Promise.resolve(JSON.stringify({ dependencies: {} }));
      }
      return Promise.resolve("// no SDK import here");
    },
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      yield "/fake/dir/smoke.test.ts";
    },
  };

  const mockScanner = new Scanner(
    mockFs,
    nodeHasher,
    SPEC_VERSION,
    emptyExtractor,
  );
  const result = await mockScanner.validate("/fake/dir");

  expect(result.valid).toBe(true);
  expect(result.errors.length).toBe(0);
});

test("Scanner.validate detects SDK dependency", async () => {
  const mockFs = {
    ...nodeFs,
    exists: (path: string) => Promise.resolve(path.endsWith("package.json")),
    readText: (path: string) => {
      if (path.endsWith("package.json")) {
        return Promise.resolve(JSON.stringify({
          dependencies: { "@glubean/sdk": "^2.0.0" },
        }));
      }
      return Promise.resolve('import { test } from "@glubean/sdk";');
    },
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      yield "/fake/dir/smoke.test.ts";
    },
  };

  const mockScanner = new Scanner(
    mockFs,
    nodeHasher,
    SPEC_VERSION,
    emptyExtractor,
  );
  const result = await mockScanner.validate("/fake/dir");

  expect(result.valid).toBe(true);
  expect(result.errors.length).toBe(0);
});

// ==================== Integration Tests ====================

const fixtureDir = resolve(__dirname, "../testdata/sample-project");

test("Scanner can validate sample-project directory", async () => {
  const scanner = new Scanner(
    nodeFs,
    nodeHasher,
    SPEC_VERSION,
    emptyExtractor,
  );

  const result = await scanner.validate(fixtureDir);

  expect(result.valid).toBe(true);
  expect(result.errors.length).toBe(0);
});

// ==================== Validation with various import patterns ====================

async function validateWithContent(content: string) {
  const mockFs = {
    ...nodeFs,
    exists: (path: string) => Promise.resolve(path.endsWith("package.json")),
    readText: (path: string) => {
      if (path.endsWith("package.json")) {
        return Promise.resolve(JSON.stringify({ dependencies: {} }));
      }
      return Promise.resolve(content);
    },
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      yield "/fake/dir/smoke.test.ts";
    },
  };

  const scanner = new Scanner(mockFs, nodeHasher, SPEC_VERSION, emptyExtractor);
  return await scanner.validate("/fake/dir");
}

test("validates when import { test } from local file", async () => {
  const result = await validateWithContent(
    'import { test } from "./fixtures.ts";',
  );
  expect(result.valid).toBe(true);
  expect(result.errors.length).toBe(0);
});

test("validates when import { test as myTest } from local file", async () => {
  const result = await validateWithContent(
    'import { test as myTest } from "./fixtures.ts";',
  );
  expect(result.valid).toBe(true);
  expect(result.errors.length).toBe(0);
});

test("validates when import { test, configure } from local file", async () => {
  const result = await validateWithContent(
    'import { test, configure } from "./fixtures.ts";',
  );
  expect(result.valid).toBe(true);
  expect(result.errors.length).toBe(0);
});

// validate() no longer inspects file content — .test.ts extension is sufficient.
test("validate passes regardless of import content (testUtils)", async () => {
  const result = await validateWithContent(
    'import { testUtils } from "./helpers.ts";',
  );
  expect(result.valid).toBe(true);
});

test("validate passes regardless of import content (latestResults)", async () => {
  const result = await validateWithContent(
    'import { latestResults } from "./data.ts";',
  );
  expect(result.valid).toBe(true);
});

test("validate passes regardless of import content (no imports)", async () => {
  const result = await validateWithContent("// no imports");
  expect(result.valid).toBe(true);
});
