/**
 * Scanner types - shared between scanner consumers.
 */

import type { ContractStaticMeta } from "./extractor-static.js";
import type { NormalizedContractMeta, NormalizedWorkflowMeta } from "./contract-extraction.js";

/** Export metadata for a single test export */
export interface ExportMeta {
  type: "test";
  /** Unique test ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Detailed description (mirrors TestMeta.description) — surfaced for team review. */
  description?: string;
  /** Tags for filtering */
  tags?: string[];
  /** Physical capability the test requires (mirrors TestMeta.requires). */
  requires?: "headless" | "browser" | "out-of-band";
  /** Default-run policy (mirrors TestMeta.defaultRun). */
  defaultRun?: "always" | "opt-in";
  /** Optional per-test timeout from TestMeta.timeout (milliseconds) */
  timeout?: number;
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
  /**
   * Trace grouping ID — the unresolved template ID for pick tests.
   * When set, the CLI uses this as the trace directory name so all
   * pick variants share one directory for easy diffing.
   *
   * Populated by runtime extraction when the SDK sets `groupId` on
   * registered test metadata (i.e., for `test.pick` tests).
   */
  groupId?: string;
  /**
   * Set when this export is a vNext `workflow(...)` (static AST detection).
   * Downstream consumers classify it as a graph orchestrator ("flow"-kind
   * runnable) without importing the file.
   */
  workflow?: true;
  /**
   * A workflow's `skip: "reason"` (WorkflowMeta.skip is a string; TestMeta.skip
   * is boolean) — mirrors TestMeta.deferred so skipped workflows are excluded
   * from the --upload branch/poll gate like deferred flows.
   */
  deferred?: string;
  /**
   * Deprecation reason (mirrors TestMeta.deprecated). Present iff the test is
   * marked deprecated — surfaced for team review so reviewers can spot stale
   * coverage without reading the file. Distinct from `deferred` (not-yet-built).
   */
  deprecated?: string;
  /** JavaScript export name (e.g., "myTest" or "default") */
  exportName: string;
  /** Source location */
  location?: { line: number; col: number };
  /** Steps for builder-style flows (visualization only) */
  steps?: { name: string; group?: string }[];
  /** Whether this test's .each() group allows parallel execution */
  parallel?: boolean;
  /**
   * Count of bare control-flow statements (`if`/`switch`/`while`/`do`/`for`) in
   * a simple test's function body. These can't be fully captured by cloud
   * dry-run projection — branches follow only one arm; loops spin to the request
   * budget — so the projection may be partial. Authors should use
   * `ctx.when()` / `ctx.switch()` / `ctx.while()` so every arm/iteration
   * projects. Absent/0 means the body has no native branching/looping (fully
   * projectable). `for…of` / `for…in` are NOT counted (handled by a
   * representative item). Conservative: defensive guards count too — better to
   * flag a partial projection than hide it.
   */
  bareBranchCount?: number;
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
  /**
   * Contract metadata extracted from .contract.ts files.
   * Independent from test exports — consumed by projection/coverage tools.
   */
  contracts?: ContractStaticMeta[];
  /**
   * FULL normalized contract projection — lossless mirror of the SDK's
   * `_extracted` form (schemas / needsSchema / runnability / given /
   * verifyRules). This is the source of truth for the Cloud
   * contract/workflow metadata snapshot. `contracts` (above) remains the
   * down-converted flat view for existing consumers.
   *
   * MUST be redacted before upload — the projection can carry examples,
   * default headers, and `extensions`/`meta` blobs that may contain secrets.
   */
  contractsProjection?: NormalizedContractMeta[];
  /**
   * vNext workflow projections (S2.6) — the JSON-safe graded node view read
   * off `BuiltWorkflow._projection` for workflows exported from runtime-
   * extractable files (.flow.ts / .contract.ts). Consumed by Cloud/agents.
   * A workflow authored in `.test.ts` is discovered/runnable but carries no
   * projection here — the scanner never imports test files (safety
   * invariant); move it to a `.flow.ts` to get the graded projection.
   */
  workflows?: NormalizedWorkflowMeta[];
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
  /**
   * Contract metadata extracted from .contract.ts files.
   * Independent from test exports — consumed by projection/coverage tools.
   */
  contracts: ContractStaticMeta[];
  /**
   * FULL normalized contract projection (schemas / needsSchema / runnability /
   * given / verifyRules), mirroring the SDK's `_extracted` form. This is the
   * lossless source `contracts` (above) is down-converted from. Consumed by
   * the Cloud metadata-snapshot upload path; `contracts` is retained for
   * existing flat/coverage consumers.
   *
   * Absent for contracts recovered via the static-regex fallback (runtime
   * import failed) — that degraded path produces only `ContractStaticMeta`.
   */
  contractsProjection?: NormalizedContractMeta[];
  /**
   * vNext workflow projections (S2.6) — graded node views read off
   * `BuiltWorkflow._projection` during runtime extraction.
   */
  workflows?: NormalizedWorkflowMeta[];
}

/** Options for scanning */
export interface ScanOptions {
  /** Spec version to use (defaults to current SPEC_VERSION) */
  specVersion?: string;
  /** Directories/patterns to skip (defaults: node_modules, .git, dist, build) */
  skipDirs?: string[];
  /** File extensions to scan (defaults: [".ts"]) */
  extensions?: string[];
  /** If true, require package.json in root (defaults: false, just warns) */
  requirePackageJson?: boolean;
}

/** Project validation result */
export interface ValidationResult {
  /** Whether the directory is a valid Glubean project */
  valid: boolean;
  /** Validation errors (if not valid) */
  errors: string[];
  /** Validation warnings (non-fatal issues) */
  warnings: string[];
  /** Detected spec version (from package.json or default) */
  detectedSpecVersion?: string;
}
