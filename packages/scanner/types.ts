/**
 * Scanner types - shared between Deno and Node.js consumers.
 */

/** Export metadata for a single test export */
export interface ExportMeta {
  type: "test";
  /** Unique test ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Tags for filtering */
  tags?: string[];
  /** Whether the test is marked as skip (should not run) */
  skip?: boolean;
  /** Whether the test is marked as only (exclusive run) */
  only?: boolean;
  /**
   * Test variant — indicates the SDK API shape used to define this test.
   *
   * - `"each"` — `test.each(data)("id-$key", fn)` (data-driven)
   * - `"pick"` — `test.pick(examples)("id-$_pick", fn)` (example selection)
   * - `undefined` — simple `test()` or builder `test("id").step(...)`
   *
   * Only populated by static analysis. Runtime extraction cannot distinguish
   * `test.each` from `test.pick` since both produce `EachBuilder` objects.
   */
  variant?: "each" | "pick";
  /** JavaScript export name (e.g., "myTest" or "default") */
  exportName: string;
  /** Source location */
  location?: { line: number; col: number };
  /** Steps for builder-style flows (visualization only) */
  steps?: { name: string; group?: string }[];
}

/** File metadata in scan result */
export interface FileMeta {
  /** File content hash (sha256-...) */
  hash: string;
  /** Exported tests from this file */
  exports: ExportMeta[];
}

/**
 * Bundle metadata stored in metadata.json.
 */
export interface BundleMetadata {
  /**
   * Schema version for metadata.json.
   * This is independent from the spec version used by the SDK.
   */
  schemaVersion: "1";
  /** Spec version used when generating metadata */
  specVersion: string;
  /** Generator identifier, e.g. "@glubean/cli@0.2.0" */
  generatedBy: string;
  /** ISO timestamp when metadata was generated */
  generatedAt: string;
  /** Root hash derived from file paths + hashes */
  rootHash: string;
  /** Files with test exports: { "path/to/file.ts": FileMeta } */
  files: Record<string, FileMeta>;
  /** Total number of tests */
  testCount: number;
  /** Total number of files with tests */
  fileCount: number;
  /** All unique tags across all tests */
  tags: string[];
  /** Optional warnings from the scanner */
  warnings?: string[];
  /** Optional bundle version (used by CLI sync) */
  version?: string;
  /** Optional project id (used by CLI sync) */
  projectId?: string;
}

/** Result of scanning a directory */
export interface ScanResult {
  /** Spec version used for scanning */
  specVersion: string;
  /** Files with test exports: { "path/to/file.ts": FileMeta } */
  files: Record<string, FileMeta>;
  /** Total number of tests */
  testCount: number;
  /** Total number of files with tests */
  fileCount: number;
  /** All unique tags across all tests */
  tags: string[];
  /** Diagnostic warnings (non-fatal issues) */
  warnings: string[];
}

/** Options for scanning */
export interface ScanOptions {
  /** Spec version to use (defaults to current SPEC_VERSION) */
  specVersion?: string;
  /** Directories/patterns to skip (defaults: node_modules, .git, dist, build) */
  skipDirs?: string[];
  /** File extensions to scan (defaults: [".ts"]) */
  extensions?: string[];
  /** If true, require deno.json in root (defaults: false, just warns) */
  requireDenoJson?: boolean;
}

/** Project validation result */
export interface ValidationResult {
  /** Whether the directory is a valid Glubean project */
  valid: boolean;
  /** Validation errors (if not valid) */
  errors: string[];
  /** Validation warnings (non-fatal issues) */
  warnings: string[];
  /** Detected spec version (from deno.json imports or default) */
  detectedSpecVersion?: string;
}
