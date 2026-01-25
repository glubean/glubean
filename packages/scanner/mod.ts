/**
 * @module @glubean/scanner
 *
 * Cross-runtime scanner for Glubean test files.
 *
 * Supports two extraction modes:
 * - **Runtime extraction** (Deno): Imports test files and reads metadata from
 *   the SDK's global registry, ensuring 100% accurate extraction.
 * - **Static analysis** (Node.js/Deno): Uses regex patterns to extract metadata
 *   without importing files. Useful for build systems and CI/CD.
 *
 * @example Deno (runtime extraction)
 * ```ts
 * import { scan, validate } from "@glubean/scanner";
 *
 * const result = await scan("./tests");
 * console.log(`Found ${result.testCount} tests`);
 * ```
 *
 * @example Node.js (static analysis)
 * ```ts
 * import { createNodeScanner } from "@glubean/scanner";
 *
 * const scanner = createNodeScanner();
 * const result = await scanner.scan("./tests");
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
export {
  SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  isSpecVersionSupported,
} from "./spec.ts";

// Re-export types
export type {
  BundleMetadata,
  ExportMeta,
  FileMeta,
  ScanResult,
  ScanOptions,
  ValidationResult,
} from "./types.ts";

// Re-export Scanner class and interfaces
export { Scanner } from "./scanner.ts";
export type { FileSystem, Hasher, MetadataExtractor } from "./scanner.ts";

// Re-export runtime extractors
export { extractWithDeno } from "./extractor-deno.ts";
export { extractWithNode } from "./extractor-node.ts";

// Re-export static analysis extractor
export {
  extractFromSource,
  createStaticExtractor,
} from "./extractor-static.ts";

// Re-export file system implementations
export { denoFs, denoHasher } from "./fs-deno.ts";
export { nodeFs, nodeHasher } from "./fs-node.ts";

// Imports for convenience functions
import { denoFs, denoHasher } from "./fs-deno.ts";
import { nodeFs, nodeHasher } from "./fs-node.ts";
import { extractWithDeno } from "./extractor-deno.ts";
import { createStaticExtractor } from "./extractor-static.ts";
import { Scanner } from "./scanner.ts";
import { SPEC_VERSION } from "./spec.ts";
import type { ScanResult, ScanOptions, ValidationResult } from "./types.ts";

// Default scanner instance for Deno (runtime extraction)
const defaultScanner = new Scanner(
  denoFs,
  denoHasher,
  SPEC_VERSION,
  extractWithDeno
);

/**
 * Validate that a directory is a valid Glubean project.
 *
 * Uses Deno file system. For Node.js, use createNodeScanner().validate().
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
 * Uses Deno runtime extraction for accurate metadata.
 * For Node.js or static-only scanning, use createNodeScanner().
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
 * Create a Deno scanner with runtime extraction.
 *
 * This is the most accurate extraction method as it imports files
 * and reads metadata from the SDK's global registry.
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
  return new Scanner(denoFs, denoHasher, specVersion, extractWithDeno);
}

/**
 * Create a Node.js scanner with static analysis.
 *
 * Uses regex-based static analysis to extract metadata without importing files.
 * This is suitable for Node.js environments and build systems.
 *
 * Note: Static analysis may miss dynamically computed metadata.
 *
 * @param specVersion Spec version to use for scanning
 * @returns New Scanner instance
 *
 * @example
 * ```ts
 * // In Node.js (e.g., NestJS server)
 * import { createNodeScanner } from "@glubean/scanner";
 *
 * const scanner = createNodeScanner();
 * const result = await scanner.scan("./tests");
 * console.log(`Found ${result.testCount} tests`);
 * ```
 */
export function createNodeScanner(specVersion: string = SPEC_VERSION): Scanner {
  const extractor = createStaticExtractor((path) => nodeFs.readText(path));
  return new Scanner(nodeFs, nodeHasher, specVersion, extractor);
}

/**
 * Create a Deno scanner with static analysis (no runtime extraction).
 *
 * Useful when you want to scan without importing files, e.g., for
 * faster scanning or when imports would have side effects.
 *
 * @param specVersion Spec version to use for scanning
 * @returns New Scanner instance
 *
 * @example
 * ```ts
 * const scanner = createStaticScanner();
 * const result = await scanner.scan("./tests");
 * ```
 */
export function createStaticScanner(
  specVersion: string = SPEC_VERSION
): Scanner {
  const extractor = createStaticExtractor((path) => denoFs.readText(path));
  return new Scanner(denoFs, denoHasher, specVersion, extractor);
}
