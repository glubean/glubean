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

test("Scanner.validate succeeds when .test.js exists", async () => {
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
      yield "/fake/dir/smoke.test.js";
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

// =============================================================================
// Contract extraction in scan()
// =============================================================================

function createMockFsWithFiles(
  files: Record<string, string>,
  packageJson = '{ "dependencies": { "@glubean/sdk": "^0.1.27" } }',
) {
  const allFiles: Record<string, string> = {
    "package.json": packageJson,
    ...files,
  };

  return {
    exists: (path: string) => Promise.resolve(path.endsWith("package.json")),
    readText: (path: string) => {
      for (const [name, content] of Object.entries(allFiles)) {
        if (path.endsWith(name)) return Promise.resolve(content);
      }
      return Promise.reject(new Error(`Not found: ${path}`));
    },
    readBytes: (path: string) => {
      for (const [name, content] of Object.entries(allFiles)) {
        if (path.endsWith(name)) return Promise.resolve(new TextEncoder().encode(content));
      }
      return Promise.reject(new Error(`Not found: ${path}`));
    },
    walk: async function* (_dir: string, _opts: any) {
      for (const name of Object.keys(allFiles)) {
        if (name !== "package.json") yield `/project/${name}`;
      }
    },
    join: (...segments: string[]) => segments.join("/"),
    relative: (_base: string, target: string) => target.replace("/project/", ""),
  };
}

const mockHasher = {
  sha256: async (content: Uint8Array) => `sha256-${content.length}`,
};

test("scan() extracts contract metadata from .contract.ts files", async () => {
  const contractSource = `
import { contract } from "@glubean/sdk";
export const getUser = contract.http("get-user", {
  endpoint: "GET /users/:id",
  client: api,
  cases: {
    success: {
      expect: { status: 200 },
    },
    notFound: {
      expect: { status: 404 },
    },
  },
});
`;

  const fs = createMockFsWithFiles({
    "contracts/users.contract.ts": contractSource,
  });

  const scanner = new Scanner(fs as any, mockHasher, "2.0", emptyExtractor);
  const result = await scanner.scan("/project");

  expect(result.contracts).toBeDefined();
  expect(result.contracts).toHaveLength(1);
  expect(result.contracts![0].contractId).toBe("get-user");
  expect(result.contracts![0].endpoint).toBe("GET /users/:id");
  expect(result.contracts![0].protocol).toBe("http");
  expect(result.contracts![0].cases).toHaveLength(2);
  expect(result.contracts![0].cases[0].key).toBe("success");
  expect(result.contracts![0].cases[1].key).toBe("notFound");
});

test("scan() flow chained syntax is not statically extractable", async () => {
  // contract.flow() uses chained builder — not extractable by static regex.
  // Flow metadata comes from registry at runtime, not static analysis.
  const flowSource = `
import { contract } from "@glubean/sdk";
export const lifecycle = contract.flow("run-lifecycle")
  .http("upload", { endpoint: "POST /cli-runs", client: uploadClient, expect: { status: 200 } })
  .http("read", { endpoint: "GET /runs/:runId", client: api, expect: { status: 200 } })
  .build();
`;

  const fs = createMockFsWithFiles({
    "contracts/runs.contract.ts": flowSource,
  });

  const scanner = new Scanner(fs as any, mockHasher, "2.0", emptyExtractor);
  const result = await scanner.scan("/project");

  expect(result.contracts).toHaveLength(0);
});

test("scan() returns empty contracts for pure test files", async () => {
  const testSource = `
import { test } from "@glubean/sdk";
export const myTest = test("my-test", async (ctx) => {});
`;

  const fs = createMockFsWithFiles({
    "tests/smoke.test.ts": testSource,
  });

  const scanner = new Scanner(fs as any, mockHasher, "2.0", emptyExtractor);
  const result = await scanner.scan("/project");

  expect(result.contracts).toBeDefined();
  expect(result.contracts).toHaveLength(0);
});

test("scan() contracts include deferred case metadata", async () => {
  const source = `
import { contract } from "@glubean/sdk";
export const deleteUser = contract.http("delete-user", {
  endpoint: "DELETE /users/:id",
  client: api,
  cases: {
    success: {
      expect: { status: 200 },
    },
    viewerBlocked: {
      expect: { status: 403 },
      deferred: "needs VIEWER_API_KEY",
    },
  },
});
`;

  const fs = createMockFsWithFiles({
    "contracts/users.contract.ts": source,
  });

  const scanner = new Scanner(fs as any, mockHasher, "2.0", emptyExtractor);
  const result = await scanner.scan("/project");

  const deferred = result.contracts![0].cases.find((c) => c.key === "viewerBlocked");
  expect(deferred).toBeDefined();
  expect(deferred!.deferred).toBe("needs VIEWER_API_KEY");
  expect(deferred!.expectStatus).toBe(403);
});
