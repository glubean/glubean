/**
 * @module configure/vars
 *
 * Lazy vars and secrets accessor builders for configure().
 *
 * Each property is an Object.defineProperty getter that resolves at access time.
 * Values support `{{key}}` template syntax or literal strings.
 * Not cached — re-reads runtime on every access so session updates are visible.
 */

import { getRuntime } from "./runtime.js";
import { resolveTemplate } from "./template.js";

/**
 * Build a lazy vars accessor. Each property resolves via resolveTemplate on access.
 * @internal
 */
export function buildLazyVars<V extends Record<string, string>>(
  mapping: Record<string, string>,
): Readonly<V> {
  const obj = {} as Record<string, string>;
  for (const [prop, value] of Object.entries(mapping)) {
    Object.defineProperty(obj, prop, {
      get() {
        const runtime = getRuntime();
        return resolveTemplate(value, runtime.vars, runtime.secrets, runtime.session);
      },
      enumerable: true,
      configurable: false,
    });
  }
  return obj as unknown as Readonly<V>;
}

/**
 * Build a lazy secrets accessor. Each property resolves via resolveTemplate on access.
 * @internal
 */
export function buildLazySecrets<S extends Record<string, string>>(
  mapping: Record<string, string>,
): Readonly<S> {
  const obj = {} as Record<string, string>;
  for (const [prop, value] of Object.entries(mapping)) {
    Object.defineProperty(obj, prop, {
      get() {
        const runtime = getRuntime();
        return resolveTemplate(value, runtime.vars, runtime.secrets, runtime.session);
      },
      enumerable: true,
      configurable: false,
    });
  }
  return obj as unknown as Readonly<S>;
}
