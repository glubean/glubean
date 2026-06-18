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

import type { RegisteredTestMeta } from "./types.js";

export {
  getRuntime,
  setRuntime,
  runWithRuntime,
  installCarrier,
  createGlobalThisCarrier,
  createAlsCarrier,
  type RuntimeCarrier,
  type InternalRuntime,
} from "./runtime-carrier.js";

// Internal-only test hook for plugin install state. Public callers use
// `installPlugin` / `listInstalledPlugins` from the main export. The matching
// bootstrap reset lives in `@glubean/runner/internal` alongside the bootstrap
// implementation (see runner/src/bootstrap.ts).
export {
  __resetInstalledPluginsForTesting,
} from "./install-plugin.js";

// ── Workflow executor internals (plan 0007) ─────────────────────────────────
// The workflow executor itself now lives in @glubean/runner (node-only), but it
// depends on SDK primitives that are NOT authoring DSL — contract adapters,
// predicate evaluation, poll primitives, static grading, retry validation. These
// are shared with the SDK's own authoring/projection/scanner paths, so they stay
// in the SDK and are bridged to the runner-side executor here. This `/internal`
// subpath is the "glubean tooling only" channel; the main `@glubean/sdk` entry
// stays authoring-only (which is the whole point of moving the executor out).
export {
  getAdapter,
  validateNeedsOutput,
  __unregisterProtocolForTesting,
} from "./contract-core.js";
export { evalPredicate, extractPredicate, resolvePath } from "./predicates.js";
export type { OpaquePredicate } from "./predicates.js";
export {
  quarantinedCtx,
  raceBudget,
  validatePollBounds,
  PollExhaustedError,
  BACKOFF_CAP_MS,
  DEFAULT_EVERY_MS,
} from "./poll-primitives.js";
export { staticGradeOf } from "./workflow/project.js";
export { validateRetryMeta } from "./workflow/retry.js";
export { clearBootstrapRegistry } from "./bootstrap-registry.js";

// Runner input channel — runner harness populates these before importing
// the user module; dispatcher reads them when applying §5.1 algorithm.
export {
  setExplicitInput,
  getExplicitInput,
  setBootstrapInput,
  getBootstrapInput,
  setForceStandalone,
  isForceStandalone,
  clearRunnerInputs,
} from "./runner-input-channel.js";

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
