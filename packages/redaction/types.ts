/**
 * @module types
 *
 * Core type definitions for the Glubean Redaction Engine.
 *
 * These types are pure TypeScript with no runtime-specific dependencies,
 * enabling consumption by both Deno (oss CLI/runner) and Node.js (server).
 *
 * The generic parameters on RedactionConfig allow the server to extend
 * base types with premium scopes and patterns without modifying this package.
 */

// ── Scopes ──────────────────────────────────────────────────────────────────

/** Which data areas the engine should scan for sensitive content. */
export interface RedactionScopes {
  requestHeaders: boolean;
  requestQuery: boolean;
  requestBody: boolean;
  responseHeaders: boolean;
  responseBody: boolean;
  consoleOutput: boolean;
  errorMessages: boolean;
  /** Whether to redact sensitive data in step return state values. */
  returnState: boolean;
}

// ── Patterns ────────────────────────────────────────────────────────────────

/** A user-defined regex pattern for value-level redaction. */
export interface CustomPattern {
  name: string;
  regex: string;
}

/** Built-in pattern toggles. Each key enables/disables a specific detector. */
export interface PatternsConfig {
  jwt: boolean;
  bearer: boolean;
  awsKeys: boolean;
  githubTokens: boolean;
  email: boolean;
  ipAddress: boolean;
  creditCard: boolean;
  hexKeys: boolean;
  custom: CustomPattern[];
}

// ── Sensitive keys ──────────────────────────────────────────────────────────

/** Configuration for key-based redaction (header names, JSON keys, etc.). */
export interface SensitiveKeysConfig {
  /** Whether to include the built-in sensitive keys list. */
  useBuiltIn: boolean;
  /** Additional keys to treat as sensitive. */
  additional: string[];
  /** Keys to exclude from the built-in list. */
  excluded: string[];
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Core redaction configuration. Extensible via generics so the server
 * can add premium scopes and patterns without modifying oss code.
 *
 * @example
 * // Server extends base config:
 * interface ServerScopes extends RedactionScopes { webhookPayloads: boolean; }
 * type ServerConfig = RedactionConfig<ServerScopes>;
 */
export interface RedactionConfig<
  TScopes extends RedactionScopes = RedactionScopes,
  TPatterns extends PatternsConfig = PatternsConfig
> {
  scopes: TScopes;
  sensitiveKeys: SensitiveKeysConfig;
  patterns: TPatterns;
  replacementFormat: "simple" | "labeled" | "partial";
}

// ── Plugin ──────────────────────────────────────────────────────────────────

/**
 * Context passed to each plugin — describes what is being redacted
 * and where in the data tree the engine currently is.
 */
export interface RedactionContext {
  /** Data scope: "requestHeaders", "responseBody", "consoleOutput", etc. */
  scope: string;
  /** Key path from root, e.g. ["data", "user", "email"] */
  path: readonly string[];
  /** Current key name (last element of path), or empty string for root values. */
  key: string;
}

/**
 * A single redaction plugin.
 *
 * Plugins are composable units that detect one category of sensitive data.
 * The engine calls plugins in registration order; first match wins for
 * key-level redaction, all patterns are applied for value-level (multi-pass).
 *
 * @example
 * ```ts
 * const myPlugin: RedactionPlugin = {
 *   name: "my-pattern",
 *   matchValue: () => new RegExp("secret_[a-z]+", "g"),
 *   partialMask: (match) => match.slice(0, 3) + "***" + match.slice(-3),
 * };
 * ```
 */
export interface RedactionPlugin {
  /** Unique identifier, used in labeled replacement: [REDACTED:<name>] */
  readonly name: string;

  /**
   * Key-level check: should the value at this key be fully redacted
   * without inspecting its content?
   *
   * Return `true` to redact, `undefined` to defer to the next plugin.
   */
  isKeySensitive?(key: string, ctx: RedactionContext): boolean | undefined;

  /**
   * Value-level check: return a RegExp that matches sensitive patterns
   * in the string value. The engine replaces all matches.
   *
   * Return `undefined` to skip this plugin for the given value.
   * The regex MUST use the global flag (/g).
   *
   * IMPORTANT: return a NEW RegExp instance every call to avoid
   * stale lastIndex in concurrent use.
   */
  matchValue?(value: string, ctx: RedactionContext): RegExp | undefined;

  /**
   * Custom partial-mask strategy for this plugin's matches.
   * Called when replacementFormat is "partial".
   *
   * If not provided, the engine applies a generic mask (first 3 + last 3 chars).
   */
  partialMask?(match: string): string;
}

// ── Result ──────────────────────────────────────────────────────────────────

/**
 * Result of a redaction operation.
 */
export interface RedactionResult {
  /** The redacted value (deep clone, original untouched). */
  value: unknown;
  /** Whether any redaction occurred. */
  redacted: boolean;
  /**
   * Per-field redaction details (for local debugging only).
   *
   * INVARIANT: details are EPHEMERAL — they must NEVER be persisted,
   * uploaded, or included in any share/server payload. The `original`
   * field contains plaintext secrets and exists solely for local
   * --verbose output where the developer wants to see what was redacted.
   */
  details: Array<{ path: string; plugin: string; original?: string }>;
}
