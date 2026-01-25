/**
 * @glubean/redaction — Plugin-based secrets/PII detection and masking.
 *
 * Pure TypeScript, no runtime-specific dependencies (no Deno.*, no node:*).
 * Consumable by both Deno (oss CLI/runner) and Node.js (server).
 *
 * @example
 * import {
 *   RedactionEngine,
 *   createBuiltinPlugins,
 *   DEFAULT_CONFIG,
 *   redactEvent,
 * } from "@glubean/redaction";
 *
 * const engine = new RedactionEngine({
 *   config: DEFAULT_CONFIG,
 *   plugins: createBuiltinPlugins(DEFAULT_CONFIG),
 * });
 *
 * const result = engine.redact({ authorization: "Bearer secret123" });
 * // result.value === { authorization: "[REDACTED]" }
 */

// Types
export type {
  RedactionScopes,
  PatternsConfig,
  SensitiveKeysConfig,
  CustomPattern,
  RedactionConfig,
  RedactionPlugin,
  RedactionContext,
  RedactionResult,
} from "./types";

// Engine
export { RedactionEngine, genericPartialMask } from "./engine";
export type { RedactionEngineOptions } from "./engine";

// Defaults
export {
  BUILT_IN_SENSITIVE_KEYS,
  PATTERN_SOURCES,
  DEFAULT_CONFIG,
} from "./defaults";

// Plugins
export {
  createBuiltinPlugins,
  sensitiveKeysPlugin,
  jwtPlugin,
  bearerPlugin,
  awsKeysPlugin,
  githubTokensPlugin,
  emailPlugin,
  ipAddressPlugin,
  creditCardPlugin,
  hexKeysPlugin,
} from "./plugins/mod";

// Adapter
export { redactEvent } from "./adapter";
export type { RedactableEvent } from "./adapter";
