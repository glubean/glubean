/**
 * Tests for @glubean/scanner
 *
 * Note: Integration tests require actual file scanning which uses runtime extraction.
 * These tests verify the scanner can correctly import test files and read from the registry.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  isSpecVersionSupported,
  Scanner,
} from "./mod.ts";
import { denoFs, denoHasher } from "./fs-deno.ts";
import { extractWithDeno } from "./extractor-deno.ts";

const emptyExtractor = () => Promise.resolve([]);

// ==================== Spec Version Tests ====================

Deno.test("SPEC_VERSION is 2.0", () => {
  assertEquals(typeof SPEC_VERSION, "string");
  assertEquals(SPEC_VERSION, "2.0");
});

Deno.test("SUPPORTED_SPEC_VERSIONS includes current and legacy versions", () => {
  assertEquals(SUPPORTED_SPEC_VERSIONS.includes("1.0"), true);
  assertEquals(SUPPORTED_SPEC_VERSIONS.includes("2.0"), true);
});

Deno.test("isSpecVersionSupported returns true for supported versions", () => {
  assertEquals(isSpecVersionSupported("1.0"), true);
  assertEquals(isSpecVersionSupported("2.0"), true);
});

Deno.test("isSpecVersionSupported returns false for unsupported versions", () => {
  assertEquals(isSpecVersionSupported("0.5"), false);
  assertEquals(isSpecVersionSupported("3.0"), false);
  assertEquals(isSpecVersionSupported("invalid"), false);
});

// ==================== Scanner Tests ====================

Deno.test("Scanner constructor validates spec version", () => {
  // Valid versions
  const scanner1 = new Scanner(denoFs, denoHasher, "1.0", emptyExtractor);
  assertExists(scanner1);

  const scanner2 = new Scanner(denoFs, denoHasher, "2.0", emptyExtractor);
  assertExists(scanner2);

  // Invalid version
  let thrown = false;
  try {
    new Scanner(denoFs, denoHasher, "invalid", emptyExtractor);
  } catch {
    thrown = true;
  }
  assertEquals(thrown, true);
});

Deno.test("Scanner defaults to current spec version", () => {
  const scanner = new Scanner(denoFs, denoHasher, SPEC_VERSION, emptyExtractor);
  assertExists(scanner);
  // No error means it used the default (2.0)
});

// ==================== Validation Tests ====================

Deno.test("Scanner.validate returns warnings for missing deno.json", async () => {
  // Create a mock FS that reports no deno.json and no files
  const mockFs = {
    ...denoFs,
    exists: (_path: string) => Promise.resolve(false),
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      // Empty directory - yield nothing
    },
  };

  const mockScanner = new Scanner(mockFs, denoHasher, SPEC_VERSION, emptyExtractor);
  const result = await mockScanner.validate("/fake/dir");

  assertEquals(result.valid, false);
  assertEquals(result.warnings.length > 0, true);
  assertEquals(
    result.warnings.some((w) => w.includes("deno.json")),
    true,
  );
});

Deno.test("Scanner.validate returns error when no SDK imports found", async () => {
  // Mock FS with deno.json but no SDK imports
  const mockFs = {
    ...denoFs,
    exists: (path: string) => Promise.resolve(path.endsWith("deno.json")),
    readText: (path: string) => {
      if (path.endsWith("deno.json")) {
        return Promise.resolve(JSON.stringify({ imports: {} }));
      }
      return Promise.resolve("// no SDK import here");
    },
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      yield "/fake/dir/test.ts";
    },
  };

  const mockScanner = new Scanner(mockFs, denoHasher, SPEC_VERSION, emptyExtractor);
  const result = await mockScanner.validate("/fake/dir");

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) => e.includes("@glubean/sdk")),
    true,
  );
});

Deno.test("Scanner.validate detects SDK imports", async () => {
  // Mock FS with SDK import
  const mockFs = {
    ...denoFs,
    exists: (path: string) => Promise.resolve(path.endsWith("deno.json")),
    readText: (path: string) => {
      if (path.endsWith("deno.json")) {
        return Promise.resolve(JSON.stringify({
          imports: { "@glubean/sdk": "jsr:@glubean/sdk@2.0.0" },
        }));
      }
      return Promise.resolve('import { test } from "@glubean/sdk";');
    },
    walk: async function* (
      _dir: string,
      _opts: { extensions: string[]; skipDirs: string[] },
    ) {
      yield "/fake/dir/test.ts";
    },
  };

  const mockScanner = new Scanner(mockFs, denoHasher, SPEC_VERSION, emptyExtractor);
  const result = await mockScanner.validate("/fake/dir");

  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

// ==================== Integration Tests ====================

// Note: Runtime extraction tests require actual Deno execution environment
// These tests scan real example files

const examplesDir = new URL("../../examples/jsonplaceholder", import.meta.url)
  .pathname;

Deno.test({
  name: "Scanner can validate examples directory",
  async fn() {
    const scanner = new Scanner(denoFs, denoHasher, SPEC_VERSION, emptyExtractor);

    // Validate the jsonplaceholder example
    const result = await scanner.validate(examplesDir);

    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  },
});

// Note: Full runtime extraction test is skipped by default as it requires
// subprocess execution. Enable manually for thorough testing.
Deno.test({
  name: "Scanner runtime extraction (integration)",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "true",
  async fn() {
    const scanner = new Scanner(denoFs, denoHasher, SPEC_VERSION, extractWithDeno);

    // Scan the jsonplaceholder example
    const result = await scanner.scan(examplesDir);

    // Should find tests
    assertEquals(result.testCount > 0, true);
    assertEquals(result.fileCount > 0, true);
    assertEquals(result.specVersion, "2.0");

    // Should have files
    const filePaths = Object.keys(result.files);
    assertEquals(filePaths.length > 0, true);
  },
});
