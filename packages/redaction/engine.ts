/**
 * @module engine
 *
 * RedactionEngine — the core recursive JSON walker that applies plugins
 * to detect and mask sensitive data.
 *
 * Ported from glubean-v1 RedactionService (policyRedactValue / policyRedactObject /
 * policyRedactString) with the monolithic class decomposed into a plugin pipeline.
 */

import type { RedactionConfig, RedactionContext, RedactionPlugin, RedactionResult } from "./types.ts";

/** Options for constructing a RedactionEngine instance. */
export interface RedactionEngineOptions<
  C extends RedactionConfig = RedactionConfig,
> {
  config: C;
  plugins: RedactionPlugin[];
  /** Max object nesting depth before truncation. Default: 10. */
  maxDepth?: number;
}

/**
 * Generic partial mask: show first 3 and last 3 characters for long values,
 * less for shorter values, full mask for very short ones.
 *
 * Used as fallback when a plugin does not provide its own partialMask().
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
 * and value-level redaction. Supports three replacement formats:
 * "simple" ([REDACTED]), "labeled" ([REDACTED:plugin_name]), "partial" (smart masking).
 */
export class RedactionEngine<C extends RedactionConfig = RedactionConfig> {
  private readonly config: C;
  private readonly plugins: RedactionPlugin[];
  private readonly maxDepth: number;

  constructor(options: RedactionEngineOptions<C>) {
    this.config = options.config;
    this.plugins = options.plugins;
    this.maxDepth = options.maxDepth ?? 10;
  }

  /**
   * Redact a value. Recursively walks objects and arrays.
   *
   * @param value   The value to redact (deep-cloned internally).
   * @param scope   Optional scope key — if the scope is disabled in config, returns value unchanged.
   */
  redact(value: unknown, scope?: keyof C["scopes"] & string): RedactionResult {
    // Scope gate: if scope is specified and disabled, skip entirely
    if (scope) {
      const scopes = this.config.scopes as unknown as Record<string, boolean>;
      if (scopes[scope] === false) {
        return { value, redacted: false, details: [] };
      }
    }

    const details: RedactionResult["details"] = [];
    const scopeStr = scope ?? "";
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
        const replacement = this.config.replacementFormat;
        if (replacement === "partial") {
          const str = value === null || value === undefined ? "" : String(value);
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

      // Test if the pattern matches
      if (regex.test(result)) {
        regex.lastIndex = 0; // Reset after test()

        const replacement = this.config.replacementFormat;
        if (replacement === "partial") {
          const maskFn = plugin.partialMask ?? genericPartialMask;
          result = result.replace(regex, (match) => maskFn(match));
        } else if (replacement === "labeled") {
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
