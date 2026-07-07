/**
 * @glubean/redaction — Plugin-based secrets/PII detection and masking.
 *
 * v2: scope-based redaction with per-scope rules and handler dispatch.
 *
 * @example
 * import {
 *   compileScopes,
 *   redactEvent,
 *   BUILTIN_SCOPES,
 *   DEFAULT_GLOBAL_RULES,
 * } from "@glubean/redaction";
 *
 * const compiled = compileScopes({
 *   builtinScopes: BUILTIN_SCOPES,
 *   globalRules: DEFAULT_GLOBAL_RULES,
 *   replacementFormat: "partial",
 * });
 *
 * const redacted = redactEvent(
 *   { type: "trace", data: { requestHeaders: { authorization: "Bearer secret" } } },
 *   compiled,
 *   "partial",
 * );
 */

// Types
export type {
  CompiledScope,
  CustomPattern,
  GlobalRules,
  HandlerContext,
  RedactionConfig,
  RedactionContext,
  RedactionHandler,
  RedactionPlugin,
  RedactionResult,
  RedactionScope,
  RedactionScopeDeclaration,
  ScopeContext,
  ScopeRules,
} from "./types.js";

// Engine
export { genericPartialMask, RedactionEngine } from "./engine.js";
export type { RedactionEngineOptions } from "./engine.js";

// Handlers
export {
  bodyHandler,
  BUILTIN_HANDLERS,
  headersHandler,
  jsonHandler,
  looksLikeFormUrlEncoded,
  rawStringHandler,
  urlQueryHandler,
} from "./handlers.js";

// Compiler
export { compileScopes, createScopeEngine, redactValue } from "./compiler.js";
export type { CompilerOptions, ScopeOverride } from "./compiler.js";

// Adapter
export { redactEvent } from "./adapter.js";
export type { RedactableEvent } from "./adapter.js";

// Defaults
export {
  BUILTIN_SCOPES,
  DEFAULT_CONFIG,
  DEFAULT_GLOBAL_RULES,
  PATTERN_SOURCES,
} from "./defaults.js";

// Plugins
export {
  awsKeysPlugin,
  bearerPlugin,
  createPatternPlugins,
  creditCardPlugin,
  emailPlugin,
  githubTokensPlugin,
  hexKeysPlugin,
  ipAddressPlugin,
  jwtPlugin,
  sensitiveKeysPlugin,
} from "./plugins/mod.js";
