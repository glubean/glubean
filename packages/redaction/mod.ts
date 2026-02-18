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
  CustomPattern,
  PatternsConfig,
  RedactionConfig,
  RedactionContext,
  RedactionPlugin,
  RedactionResult,
  RedactionScopes,
  SensitiveKeysConfig,
} from "./types.ts";

// Engine
export { genericPartialMask, RedactionEngine } from "./engine.ts";
export type { RedactionEngineOptions } from "./engine.ts";

// Defaults
export { BUILT_IN_SENSITIVE_KEYS, DEFAULT_CONFIG, PATTERN_SOURCES } from "./defaults.ts";

// Plugins
export {
  awsKeysPlugin,
  bearerPlugin,
  createBuiltinPlugins,
  creditCardPlugin,
  emailPlugin,
  githubTokensPlugin,
  hexKeysPlugin,
  ipAddressPlugin,
  jwtPlugin,
  sensitiveKeysPlugin,
} from "./plugins/mod.ts";

// Adapter
export { redactEvent } from "./adapter.ts";
export type { RedactableEvent } from "./adapter.ts";
