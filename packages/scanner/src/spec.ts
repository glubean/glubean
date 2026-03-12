/**
 * Glubean Spec Version
 *
 * This defines the contract between SDK, Scanner, and Runner.
 * - Major version: Breaking changes (Scanner/Runner may not be compatible)
 * - Minor version: New features (backward compatible)
 *
 * History:
 * - 1.0: Initial release
 *   - testCase(meta, fn) and testSuite(meta, config)
 *   - TestContext: vars, secrets, log, assert, trace
 *   - TestCaseMeta: id, name, description, tags, timeout, only, skip
 *   - TestSuiteMeta: id, name, description, tags, only, skip
 *
 * - 2.0: Unified Builder API
 *   - test(meta, fn) for simple tests (replaces testCase)
 *   - test(id).step().build() for multi-step tests (replaces testSuite)
 *   - Global registry for runtime metadata extraction
 *   - Legacy testCase/testSuite API removed
 */
export const SPEC_VERSION = "2.0";

/**
 * Supported spec versions for scanning.
 * Scanner can read test files from these versions.
 */
export const SUPPORTED_SPEC_VERSIONS = ["1.0", "2.0"] as const;

/**
 * Check if a spec version is supported by this scanner.
 */
export function isSpecVersionSupported(version: string): boolean {
  return SUPPORTED_SPEC_VERSIONS.includes(
    version as (typeof SUPPORTED_SPEC_VERSIONS)[number],
  );
}
