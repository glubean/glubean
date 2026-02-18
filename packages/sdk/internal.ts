/**
 * Internal API for Glubean SDK.
 *
 * ⚠️ **WARNING**: This module is for internal use by Glubean tooling only.
 * The APIs here are NOT part of the public SDK contract and may change without notice.
 *
 * Do not import from this module in your test code.
 *
 * @module internal
 * @internal
 */

import type { RegisteredTestMeta } from "./types.ts";

/**
 * Global registry for test metadata.
 * Populated at import time when test files are loaded.
 * Used by scanner to extract metadata without executing tests.
 *
 * @internal
 */
const _registry: RegisteredTestMeta[] = [];

/**
 * Register a test to the global registry.
 * Called internally by the test builders.
 *
 * @internal
 */
export function registerTest(meta: RegisteredTestMeta): void {
  _registry.push(meta);
}

/**
 * Get all registered test metadata.
 * Called by scanner after importing test files.
 *
 * @internal
 *
 * @example For scanner usage only
 * ```ts
 * import { getRegistry } from "@glubean/sdk/internal";
 * const tests = getRegistry();
 * ```
 */
export function getRegistry(): RegisteredTestMeta[] {
  return [..._registry];
}

/**
 * Clear the registry (for testing purposes).
 *
 * @internal
 */
export function clearRegistry(): void {
  _registry.length = 0;
}
