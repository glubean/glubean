/**
 * Sensitive-keys plugin — key-level redaction.
 *
 * Checks if a JSON key or header name matches one of the configured
 * sensitive keys (case-insensitive substring match).
 *
 * @example
 * // "x-authorization-token" matches "authorization"
 * // "X-Api-Key" matches "api-key" (after lowercasing)
 */

import type { RedactionPlugin, SensitiveKeysConfig } from "../types";
import { BUILT_IN_SENSITIVE_KEYS } from "../defaults";

/**
 * Build the sensitive key set from config.
 * If useBuiltIn is true, starts with BUILT_IN_SENSITIVE_KEYS,
 * adds `additional`, removes `excluded`.
 */
function buildKeySet(config: SensitiveKeysConfig): Set<string> {
  const keys = new Set<string>();

  if (config.useBuiltIn) {
    for (const k of BUILT_IN_SENSITIVE_KEYS) {
      keys.add(k);
    }
  }

  for (const k of config.additional ?? []) {
    keys.add(k.toLowerCase());
  }

  for (const k of config.excluded ?? []) {
    keys.delete(k.toLowerCase());
  }

  return keys;
}

/**
 * Create a sensitive-keys plugin from config.
 *
 * Key matching uses case-insensitive substring — "x-authorization-token"
 * matches "authorization".
 */
export function sensitiveKeysPlugin(
  config: SensitiveKeysConfig
): RedactionPlugin {
  const keys = buildKeySet(config);

  return {
    name: "sensitive-keys",
    isKeySensitive: (key: string): boolean | undefined => {
      const lower = key.toLowerCase();
      // Exact match first (fast path)
      if (keys.has(lower)) return true;
      // Substring match
      for (const sensitive of keys) {
        if (lower.includes(sensitive)) return true;
      }
      return undefined;
    },
  };
}
