/**
 * @module engine
 *
 * RedactionEngine — recursive JSON walker that applies plugins
 * to detect and mask sensitive data.
 *
 * v2: the engine is instantiated per-scope with a scope-specific plugin pipeline.
 * It no longer does scope gating — that responsibility moves to the compiler/dispatcher.
 */

import type {
  RedactionContext,
  RedactionPlugin,
  RedactionResult,
  ScopeContext,
} from "./types.js";

/** Options for constructing a RedactionEngine instance. */
export interface RedactionEngineOptions {
  /** Plugin pipeline for this engine instance. */
  plugins: RedactionPlugin[];
  /** Replacement format. */
  replacementFormat: "simple" | "labeled" | "partial";
  /** Max object nesting depth before truncation. Default: 10. */
  maxDepth?: number;
  /**
   * When true, a SENSITIVE KEY whose value is an object/array is RECURSED
   * into (structure preserved, scalar leaves still redacted) rather than
   * replaced wholesale with a redaction string. Default false (the event
   * path nukes the whole subtree, which is correct for event payloads).
   *
   * Set for deep-redacting JSON-Schema-bearing payloads (the contract/flow
   * projection): a schema node like `properties.password = { type: "string" }`
   * must keep its shape — nuking it to "[REDACTED]" would corrupt the
   * projection canonical-hash/OpenAPI consumers depend on. Scalar secrets
   * under a sensitive key (e.g. `authorization: "Bearer …"`) are still masked.
   */
  sensitiveKeyRecurse?: boolean;
}

/**
 * Generic partial mask: show first 3 and last 3 characters for long values,
 * less for shorter values, full mask for very short ones.
 */
export function genericPartialMask(value: string): string {
  const len = value.length;
  if (len <= 4) return "****";
  if (len <= 8) return value.slice(0, 2) + "***" + value.slice(-1);
  return value.slice(0, 3) + "***" + value.slice(-3);
}

/**
 * Plugin-based redaction engine.
 *
 * Walks JSON values recursively, applying registered plugins for key-level
 * and value-level redaction.
 */
export class RedactionEngine {
  private readonly plugins: RedactionPlugin[];
  private readonly replacementFormat: "simple" | "labeled" | "partial";
  private readonly maxDepth: number;
  private readonly sensitiveKeyRecurse: boolean;

  constructor(options: RedactionEngineOptions) {
    this.plugins = options.plugins;
    this.replacementFormat = options.replacementFormat;
    this.maxDepth = options.maxDepth ?? 10;
    this.sensitiveKeyRecurse = options.sensitiveKeyRecurse ?? false;
  }

  /**
   * Redact a value. Recursively walks objects and arrays.
   *
   * @param value The value to redact.
   * @param ctx   Optional scope context for plugin dispatch.
   */
  redact(value: unknown, ctx?: ScopeContext): RedactionResult {
    const scopeStr = ctx?.id ?? "";
    const details: RedactionResult["details"] = [];
    const result = this.walkValue(value, scopeStr, [], details, 0);
    return {
      value: result.value,
      redacted: result.didRedact,
      details,
    };
  }

  // ── Private recursive walker ──────────────────────────────────────────

  private walkValue(
    value: unknown,
    scope: string,
    path: string[],
    details: RedactionResult["details"],
    depth: number,
  ): { value: unknown; didRedact: boolean } {
    if (depth > this.maxDepth) {
      return { value: "[REDACTED: too deep]", didRedact: true };
    }

    if (value === null || value === undefined) {
      return { value, didRedact: false };
    }

    if (typeof value === "string") {
      return this.walkString(value, scope, path, details);
    }

    if (Array.isArray(value)) {
      let didRedact = false;
      const redactedArray = value.map((item, i) => {
        const result = this.walkValue(
          item,
          scope,
          [...path, String(i)],
          details,
          depth + 1,
        );
        if (result.didRedact) didRedact = true;
        return result.value;
      });
      return { value: redactedArray, didRedact };
    }

    if (typeof value === "object") {
      return this.walkObject(
        value as Record<string, unknown>,
        scope,
        path,
        details,
        depth,
      );
    }

    // Numbers, booleans, etc. — pass through
    return { value, didRedact: false };
  }

  private walkObject(
    obj: Record<string, unknown>,
    scope: string,
    path: string[],
    details: RedactionResult["details"],
    depth: number,
  ): { value: Record<string, unknown>; didRedact: boolean } {
    let didRedact = false;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const keyPath = [...path, key];
      const ctx: RedactionContext = { scope, path: keyPath, key };

      // Key-level check: first plugin returning true wins
      let keySensitive = false;
      let keyPluginName = "";
      for (const plugin of this.plugins) {
        if (plugin.isKeySensitive) {
          const hit = plugin.isKeySensitive(key, ctx);
          if (hit === true) {
            keySensitive = true;
            keyPluginName = plugin.name;
            break;
          }
        }
      }

      if (keySensitive) {
        // Recurse-mode: a sensitive key over a container (object/array) keeps
        // its structure — recurse so JSON-Schema nodes aren't flattened to a
        // redaction string. Scalar leaves still fall through to masking.
        const isContainer = value !== null && typeof value === "object";
        if (this.sensitiveKeyRecurse && isContainer) {
          const redacted = this.walkValue(value, scope, keyPath, details, depth + 1);
          result[key] = redacted.value;
          if (redacted.didRedact) didRedact = true;
          continue;
        }
        if (this.replacementFormat === "partial") {
          const str =
            value === null || value === undefined ? "" : String(value);
          result[key] = genericPartialMask(str);
        } else {
          result[key] = "[REDACTED]";
        }
        didRedact = true;
        details.push({
          path: keyPath.join("."),
          plugin: keyPluginName,
          original: typeof value === "string" ? value : undefined,
        });
        continue;
      }

      // Recurse into value
      const redacted = this.walkValue(
        value,
        scope,
        keyPath,
        details,
        depth + 1,
      );
      result[key] = redacted.value;
      if (redacted.didRedact) didRedact = true;
    }

    return { value: result, didRedact };
  }

  private walkString(
    str: string,
    scope: string,
    path: string[],
    details: RedactionResult["details"],
  ): { value: string; didRedact: boolean } {
    let result = str;
    let didRedact = false;
    const ctx: RedactionContext = {
      scope,
      path,
      key: path.length > 0 ? path[path.length - 1] : "",
    };

    for (const plugin of this.plugins) {
      if (!plugin.matchValue) continue;

      const regex = plugin.matchValue(result, ctx);
      if (!regex) continue;

      if (regex.test(result)) {
        regex.lastIndex = 0; // Reset after test()

        if (this.replacementFormat === "partial") {
          const maskFn = plugin.partialMask ?? genericPartialMask;
          result = result.replace(regex, (match) => maskFn(match));
        } else if (this.replacementFormat === "labeled") {
          const tag = `[REDACTED:${plugin.name}]`;
          result = result.replace(regex, tag);
        } else {
          result = result.replace(regex, "[REDACTED]");
        }

        didRedact = true;
        details.push({
          path: path.join("."),
          plugin: plugin.name,
          original: str,
        });
      }
    }

    return { value: result, didRedact };
  }
}
