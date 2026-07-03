/**
 * @module types
 *
 * Core type definitions for the Glubean Redaction Engine v2.
 *
 * v2 replaces hardcoded HTTP scopes with a data-driven declaration model.
 * Scopes, handlers, and rules are all extensible by plugins.
 */

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * A redaction scope declaration.
 *
 * Scopes define **what** to redact: which event type, which field path,
 * and which rules (sensitive keys / patterns) apply in that context.
 *
 * Scopes do NOT define how to interpret the payload — that is the handler's job.
 * The `handler` field selects one registered handler by name.
 */
export interface RedactionScope {
  /** Stable config key for user overrides. */
  id: string;
  /** Human-readable label for UI/docs. */
  name: string;
  /** Match event type: "trace", "log", "assertion", "error", etc. */
  event: string;
  /** Dot-path into the event to locate the payload. "$self" for the whole event. */
  target: string;
  /** Whether the scope is enabled. Default: true. */
  enabled: boolean;
  /** Which handler interprets the selected payload. */
  handler: string;
  /** Scope-specific rules. Merged with global rules at compile time. */
  rules?: ScopeRules;
}

/** Scope-specific redaction rules. Additive only — merged with global rules. */
export interface ScopeRules {
  /** Additional sensitive keys for this scope. */
  sensitiveKeys?: string[];
  /** Pattern names to enable for this scope. */
  patterns?: string[];
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * A redaction handler — interprets a specific payload shape.
 *
 * Handlers are registered by name. Each scope selects exactly one handler.
 * The handler is responsible for parsing the payload, calling the engine
 * on normalized intermediate data, and serializing back if needed.
 */
/**
 * Engine interface used by handlers. Matches RedactionEngine.redact() signature.
 * Avoids circular imports between types.ts and engine.ts.
 */
export interface RedactionEngineInterface {
  redact(value: unknown, ctx?: ScopeContext): RedactionResult;
  /**
   * Mask a scalar as fully sensitive, honoring the engine's replacement
   * format (partial → `abc***xyz`, simple/labeled → `[REDACTED]`). For
   * handlers that decide a value is sensitive STRUCTURALLY — e.g. a cookie
   * value, sensitive by virtue of living under a `Cookie`/`Set-Cookie`
   * header — rather than via key/pattern plugins. Optional so third-party
   * engine implementations of this interface need not provide it.
   */
  maskValue?(value: string): string;
}

export interface RedactionHandler {
  /** Handler name — must match the `handler` field in scope declarations. */
  name: string;
  /**
   * Process a value and return the redacted result.
   *
   * The handler receives the raw value extracted from the event by field path.
   * It should call `engine.redact()` on normalized intermediate structures
   * (e.g., parsed query params, cookie name/value pairs) and serialize back.
   */
  process(
    value: unknown,
    ctx: HandlerContext,
    engine: RedactionEngineInterface,
  ): RedactionResult;
}

/** Context passed to handlers during processing. */
export interface HandlerContext {
  /** The scope id being processed. */
  scopeId: string;
  /** The scope name being processed. */
  scopeName: string;
}

/** Minimal scope context passed to the engine's redact method. */
export interface ScopeContext {
  id: string;
  name: string;
}

// ── Patterns ─────────────────────────────────────────────────────────────────

/** A user-defined regex pattern for value-level redaction. */
export interface CustomPattern {
  name: string;
  regex: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Global additive rules — applied to all scopes as baseline. */
export interface GlobalRules {
  /** Additional sensitive keys applied to all scopes. */
  sensitiveKeys: string[];
  /** Pattern names enabled globally. */
  patterns: string[];
  /** User-defined custom regex patterns. */
  customPatterns: CustomPattern[];
}

/**
 * Redaction configuration v2.
 *
 * Scopes are data-driven declarations, not a fixed boolean interface.
 * Global rules are additive only — scope-specific rules take precedence.
 */
export interface RedactionConfig {
  /** Scope declarations. */
  scopes: RedactionScope[];
  /** Global additive rules. */
  globalRules: GlobalRules;
  /** How to replace redacted values. */
  replacementFormat: "simple" | "labeled" | "partial";
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * Context passed to redaction plugins during engine traversal.
 */
export interface RedactionContext {
  /** Scope id being processed. */
  scope: string;
  /** Key path from root, e.g. ["data", "user", "email"]. */
  path: readonly string[];
  /** Current key name (last element of path), or empty string for root. */
  key: string;
}

/**
 * A redaction plugin — detects one category of sensitive data.
 *
 * Plugins are composable units. The engine calls plugins in registration order;
 * first match wins for key-level, all patterns are applied for value-level.
 */
export interface RedactionPlugin {
  /** Unique identifier, used in labeled replacement: [REDACTED:<name>]. */
  readonly name: string;

  /**
   * Key-level check: should the value at this key be fully redacted?
   * Return `true` to redact, `undefined` to defer to the next plugin.
   */
  isKeySensitive?(key: string, ctx: RedactionContext): boolean | undefined;

  /**
   * Value-level check: return a RegExp matching sensitive patterns.
   * Must use the global flag (/g). Return a NEW instance every call.
   */
  matchValue?(value: string, ctx: RedactionContext): RegExp | undefined;

  /**
   * Custom partial-mask for this plugin's matches.
   * If not provided, the engine uses genericPartialMask().
   */
  partialMask?(match: string): string;
}

// ── Result ───────────────────────────────────────────────────────────────────

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
   * uploaded, or included in any share/server payload.
   */
  details: Array<{ path: string; plugin: string; original?: string }>;
}

// ── Compiled Scope ───────────────────────────────────────────────────────────

/**
 * A compiled scope ready for execution.
 *
 * Created by the compiler from declarations + global rules + user overrides.
 * Contains pre-resolved handler, plugin pipeline, and field accessors.
 */
export interface CompiledScope {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  /** Extract target value from an event. */
  get(event: Record<string, unknown>): unknown;
  /** Write redacted value back to event. */
  set(event: Record<string, unknown>, value: unknown): void;
  /** Resolved handler for this scope. */
  handler: RedactionHandler;
  /** Per-scope redaction plugin pipeline. */
  plugins: RedactionPlugin[];
}

// ── Scope Declaration (for plugins) ──────────────────────────────────────────

/**
 * Scope declaration used by plugins in PluginFactory.redaction.
 * Same shape as RedactionScope but `enabled` defaults to true.
 */
export interface RedactionScopeDeclaration {
  id: string;
  name: string;
  event: string;
  target: string;
  handler: string;
  rules?: ScopeRules;
}
