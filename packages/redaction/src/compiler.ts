/**
 * @module compiler
 *
 * Compiles scope declarations into ready-to-execute CompiledScope[].
 *
 * Flow:
 * 1. Merge built-in + plugin scope declarations
 * 2. Apply user overrides by scope id
 * 3. Resolve handler for each scope
 * 4. Build per-scope plugin pipeline (scope keys + global keys + patterns)
 * 5. Return CompiledScope[] for use by redactEvent()
 */

import type {
  CompiledScope,
  GlobalRules,
  RedactionConfig,
  RedactionHandler,
  RedactionPlugin,
  RedactionScope,
  RedactionScopeDeclaration,
  ScopeRules,
} from "./types.js";
import { RedactionEngine } from "./engine.js";
import { BUILTIN_HANDLERS } from "./handlers.js";
import { sensitiveKeysPlugin } from "./plugins/sensitive-keys.js";
import { createPatternPlugins } from "./plugins/mod.js";
import { PATTERN_SOURCES } from "./defaults.js";

/** User-provided scope overrides keyed by scope id. */
export interface ScopeOverride {
  enabled?: boolean;
  rules?: ScopeRules;
}

/** Compiler options. */
export interface CompilerOptions {
  /** Built-in scope declarations (HTTP, log, error, etc.). */
  builtinScopes: RedactionScopeDeclaration[];
  /** Plugin-provided scope declarations. */
  pluginScopes?: RedactionScopeDeclaration[];
  /** Plugin-provided custom handlers. */
  pluginHandlers?: RedactionHandler[];
  /** User overrides by scope id. */
  userOverrides?: Record<string, ScopeOverride>;
  /** Global additive rules. */
  globalRules: GlobalRules;
  /** Replacement format. */
  replacementFormat: "simple" | "labeled" | "partial";
  /** Max object nesting depth. Default: 10. */
  maxDepth?: number;
}

/**
 * Resolve field path accessor functions.
 *
 * Supports dot-separated paths (e.g., "data.requestHeaders")
 * and "$self" for the whole event.
 */
function makeAccessors(target: string): {
  get: (event: Record<string, unknown>) => unknown;
  set: (event: Record<string, unknown>, value: unknown) => void;
} {
  if (target === "$self") {
    return {
      get: (event) => event,
      set: (event, value) => {
        // $self: merge redacted properties back onto the event
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const redacted = value as Record<string, unknown>;
          for (const key of Object.keys(redacted)) {
            event[key] = redacted[key];
          }
        }
      },
    };
  }

  const parts = target.split(".");

  return {
    get(event) {
      let current: unknown = event;
      for (const part of parts) {
        if (current == null || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    },
    set(event, value) {
      let current: Record<string, unknown> = event;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = current[parts[i]];
        if (next == null || typeof next !== "object") return;
        current = next as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    },
  };
}

/**
 * Build the plugin pipeline for a specific scope.
 *
 * Order:
 * 1. Sensitive keys plugin (scope-specific + global additive keys)
 * 2. Pattern plugins (scope-specific + global patterns)
 * 3. Custom patterns from global rules
 */
function buildScopePlugins(
  scopeRules: ScopeRules | undefined,
  globalRules: GlobalRules,
  useBuiltInKeys = false,
): RedactionPlugin[] {
  const plugins: RedactionPlugin[] = [];

  // Merge sensitive keys: scope-specific + global
  const allKeys = new Set<string>();
  if (scopeRules?.sensitiveKeys) {
    for (const k of scopeRules.sensitiveKeys) allKeys.add(k.toLowerCase());
  }
  for (const k of globalRules.sensitiveKeys) allKeys.add(k.toLowerCase());

  // Per-event scopes carry their own key list (useBuiltInKeys=false), so the
  // built-in baseline only applies when a caller opts in (e.g. redactValue
  // over a non-event payload, where there is no scope to supply keys).
  if (useBuiltInKeys || allKeys.size > 0) {
    plugins.push(
      sensitiveKeysPlugin({
        useBuiltIn: useBuiltInKeys,
        additional: [...allKeys],
        excluded: [],
      }),
    );
  }

  // Merge pattern names: scope-specific + global
  const enabledPatterns = new Set<string>();
  if (scopeRules?.patterns) {
    for (const p of scopeRules.patterns) enabledPatterns.add(p);
  }
  for (const p of globalRules.patterns) enabledPatterns.add(p);

  // Add pattern plugins for enabled patterns
  const patternPlugins = createPatternPlugins(enabledPatterns);
  plugins.push(...patternPlugins);

  // Add custom patterns from global rules
  for (const custom of globalRules.customPatterns) {
    try {
      new RegExp(custom.regex, "g");
      plugins.push({
        name: custom.name,
        matchValue: () => new RegExp(custom.regex, "g"),
      });
    } catch {
      // Skip invalid regex
    }
  }

  return plugins;
}

/**
 * Compile scope declarations into ready-to-execute CompiledScope[].
 */
export function compileScopes(options: CompilerOptions): CompiledScope[] {
  // Merge all scope declarations
  const allDeclarations = [
    ...options.builtinScopes,
    ...(options.pluginScopes ?? []),
  ];

  // Build handler registry
  const handlers: Record<string, RedactionHandler> = { ...BUILTIN_HANDLERS };
  if (options.pluginHandlers) {
    for (const h of options.pluginHandlers) {
      handlers[h.name] = h;
    }
  }

  // Compile each scope
  const compiled: CompiledScope[] = [];

  for (const decl of allDeclarations) {
    // Apply user overrides
    const override = options.userOverrides?.[decl.id];
    const enabled = override?.enabled ?? true;
    const rules: ScopeRules = {
      sensitiveKeys: [
        ...(decl.rules?.sensitiveKeys ?? []),
        ...(override?.rules?.sensitiveKeys ?? []),
      ],
      patterns: [
        ...(decl.rules?.patterns ?? []),
        ...(override?.rules?.patterns ?? []),
      ],
    };

    // Resolve handler
    const handler = handlers[decl.handler];
    if (!handler) {
      throw new Error(
        `Redaction scope "${decl.id}" references unknown handler "${decl.handler}"`,
      );
    }

    // Build per-scope plugin pipeline
    const plugins = buildScopePlugins(rules, options.globalRules);

    // Build field accessors
    const accessors = makeAccessors(decl.target);

    compiled.push({
      id: decl.id,
      name: decl.name,
      event: decl.event,
      enabled,
      get: accessors.get,
      set: accessors.set,
      handler,
      plugins,
    });
  }

  return compiled;
}

/**
 * Create a scope-specific RedactionEngine instance.
 *
 * Each scope gets its own engine with its own plugin pipeline.
 */
export function createScopeEngine(
  scope: CompiledScope,
  replacementFormat: "simple" | "labeled" | "partial",
  maxDepth?: number,
): RedactionEngine {
  return new RedactionEngine({
    plugins: scope.plugins,
    replacementFormat,
    maxDepth,
  });
}

/**
 * Deep-redact an arbitrary JSON value using GLOBAL rules only (no event scope).
 *
 * Unlike `redactEvent` — which targets specific payload fields of a *known*
 * event type via compiled scopes — this walks the entire value tree applying
 * the global sensitive-keys + pattern plugins. Use it for non-event payloads
 * that may carry secrets at any path, e.g. the contract/flow metadata
 * projection uploaded to Cloud (examples, default headers, gRPC metadata,
 * `extensions`/`meta` blobs).
 *
 * The plugin pipeline is built by the same `buildScopePlugins` path the
 * per-scope engines use, so global rules remain the single source of truth
 * for what counts as sensitive.
 *
 * Because there is NO event scope to supply key-based rules, this path opts
 * into the built-in sensitive-key baseline by default
 * (`useBuiltInSensitiveKeys: true`) — without it, a payload like
 * `{ authorization: "sk_live_…" }` whose value matches no value-pattern would
 * pass through unredacted. Pass `sensitiveKeys` to add scope-level keys
 * (e.g. the union of `BUILTIN_SCOPES` keys) so a non-event payload is redacted
 * at least as strongly as events are.
 *
 * Returns a redacted deep clone; the input is never mutated. When the
 * resolved rules contribute no plugins the input is returned unchanged.
 *
 * `maxDepth` bounds recursion (default mirrors the engine's own default of
 * 10). Callers redacting deeply-nested structures — JSON Schemas, recursive
 * flow branch trees — should pass a generous value so legitimate structure
 * isn't truncated to a `[REDACTED: too deep]` sentinel.
 */
/**
 * HTTP multi-value headers/cookies whose ARRAY value carries scalar secrets
 * (not structure). In recurse-mode these are the only keys whose array
 * ELEMENTS are masked by key — every other sensitive-named key (e.g. a
 * JSON-Schema `dependentRequired: { password: [...] }`) keeps its array intact.
 * Lower-cased for case-insensitive matching.
 */
const MULTI_VALUE_SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

export function redactValue(
  value: unknown,
  options: {
    globalRules: GlobalRules;
    /** Extra sensitive keys (e.g. union of `BUILTIN_SCOPES` keys). */
    sensitiveKeys?: string[];
    /** Include the built-in sensitive-key baseline. Default: true. */
    useBuiltInSensitiveKeys?: boolean;
    replacementFormat?: "simple" | "labeled" | "partial";
    maxDepth?: number;
  },
): unknown {
  const plugins = buildScopePlugins(
    { sensitiveKeys: options.sensitiveKeys ?? [], patterns: [] },
    options.globalRules,
    options.useBuiltInSensitiveKeys ?? true,
  );
  if (plugins.length === 0) return value;
  const engine = new RedactionEngine({
    plugins,
    replacementFormat: options.replacementFormat ?? "partial",
    maxDepth: options.maxDepth,
    // Preserve JSON-Schema structure: a sensitive key over a schema node
    // (e.g. `properties.password`) is recursed into, not flattened to a
    // redaction string. Scalar secrets under sensitive keys are still masked.
    sensitiveKeyRecurse: true,
    // …but a multi-value HTTP header/cookie array (`authorization: [...]`,
    // `set-cookie: [...]`) carries scalar secrets, not structure — mask its
    // elements. Other sensitive-named arrays (JSON-Schema keyword lists) are
    // left intact. See RedactionEngineOptions.multiValueSecretKeys.
    multiValueSecretKeys: MULTI_VALUE_SECRET_HEADERS,
  });
  return engine.redact(value).value;
}
