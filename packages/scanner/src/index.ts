/**
 * @module @glubean/scanner
 *
 * Scanner for Glubean test files.
 *
 * Supports two extraction modes:
 * - **Static analysis**: Uses regex patterns to extract metadata
 *   without importing files. Works everywhere.
 * - **Runtime extraction**: Imports test files via tsx subprocess and reads
 *   metadata from the SDK's global registry (100% accurate).
 *
 * @example Static analysis (default)
 * ```ts
 * import { createScanner } from "@glubean/scanner";
 *
 * const scanner = createScanner();
 * const result = await scanner.scan("./tests");
 * console.log(`Found ${result.testCount} tests`);
 * ```
 *
 * @example Pure static analysis (no file system)
 * ```ts
 * import { extractFromSource } from "@glubean/scanner";
 *
 * const content = fs.readFileSync("test.ts", "utf-8");
 * const exports = extractFromSource(content);
 * ```
 */

// Re-export spec constants
export { isSpecVersionSupported, SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } from "./spec.js";

// Re-export types
export type { BundleMetadata, ExportMeta, FileMeta, ScanOptions, ScanResult, ValidationResult } from "./types.js";

// Re-export Scanner class and interfaces
export { Scanner } from "./scanner.js";
export type { FileSystem, Hasher, MetadataExtractor } from "./scanner.js";

// Re-export static analysis extractor
export { createStaticExtractor, extractAliasesFromSource, extractContractCases, extractFromSource, isGlubeanFile } from "./extractor-static.js";
export type { ContractStaticMeta, ContractCaseStaticMeta } from "./extractor-static.js";

// Re-export file system implementations
export { nodeFs, nodeHasher } from "./fs.js";

// Imports for convenience functions
import { nodeFs, nodeHasher } from "./fs.js";
import { createStaticExtractor } from "./extractor-static.js";
import { Scanner } from "./scanner.js";
import { SPEC_VERSION } from "./spec.js";
import type { ScanOptions, ScanResult, ValidationResult } from "./types.js";

// Default scanner instance (static analysis)
const defaultScanner = new Scanner(
  nodeFs,
  nodeHasher,
  SPEC_VERSION,
  createStaticExtractor((path) => nodeFs.readText(path)),
);

/**
 * Validate that a directory is a valid Glubean project.
 *
 * @param dir Directory to validate
 * @returns Validation result with errors and warnings
 *
 * @example
 * ```ts
 * const result = await validate("./tests");
 * if (!result.valid) {
 *   console.error("Errors:", result.errors);
 * }
 * ```
 */
export function validate(dir: string): Promise<ValidationResult> {
  return defaultScanner.validate(dir);
}

/**
 * Scan a directory for Glubean test files.
 *
 * Uses static analysis by default. For runtime extraction,
 * create a Scanner with a custom MetadataExtractor.
 *
 * @param dir Directory to scan
 * @param options Scan options
 * @returns Scan result with file metadata and test counts
 *
 * @example
 * ```ts
 * const result = await scan("./tests");
 * console.log(`Found ${result.testCount} tests`);
 * ```
 */
export function scan(dir: string, options?: ScanOptions): Promise<ScanResult> {
  return defaultScanner.scan(dir, options);
}

/**
 * Create a scanner with static analysis extraction.
 *
 * Uses regex-based static analysis to extract metadata without importing files.
 *
 * @param specVersion Spec version to use for scanning
 * @returns New Scanner instance
 *
 * @example
 * ```ts
 * const scanner = createScanner("2.0");
 * const result = await scanner.scan("./tests");
 * ```
 */
export function createScanner(specVersion: string = SPEC_VERSION): Scanner {
  const extractor = createStaticExtractor((path) => nodeFs.readText(path));
  return new Scanner(nodeFs, nodeHasher, specVersion, extractor);
}
