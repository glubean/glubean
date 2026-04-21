/**
 * @module configure/plugin
 *
 * Lazy plugin builder for configure().
 *
 * Each plugin is a transparent Proxy at module load time. On first property
 * access during test execution, the plugin factory is called with an augmented
 * GlubeanRuntime. The instance is cached per runtime identity via WeakMap.
 */

import type { GlubeanRuntime, PluginFactory } from "../types.js";
import { getRuntime, requireVar, requireSecret, type InternalRuntime } from "./runtime.js";
import { resolveTemplate } from "./template.js";

/** Reserved keys that plugins cannot shadow. */
export const RESERVED_KEYS = new Set(["vars", "secrets", "http"]);

/**
 * Resolve (or retrieve cached) the real plugin instance for the current runtime.
 * @internal
 */
function resolvePlugin(
  factory: PluginFactory<any>,
  cache: WeakMap<InternalRuntime, unknown>,
): unknown {
  const runtime = getRuntime();
  if (cache.has(runtime)) return cache.get(runtime);

  const noop = () => {};
  const augmented: GlubeanRuntime = {
    vars: runtime.vars,
    secrets: runtime.secrets,
    http: runtime.http,
    test: runtime.test,
    requireVar,
    requireSecret,
    resolveTemplate: (template: string) =>
      resolveTemplate(template, runtime.vars, runtime.secrets, runtime.session),
    trace: runtime.trace?.bind(runtime) ?? noop,
    action: runtime.action?.bind(runtime) ?? noop,
    event: runtime.event?.bind(runtime) ?? noop,
    log: runtime.log?.bind(runtime) ?? noop,
  };

  const instance = factory.create(augmented);
  cache.set(runtime, instance);
  return instance;
}

/**
 * Build a transparent Proxy that defers plugin instantiation until first use.
 * @internal
 */
export function buildLazyPlugin(factory: PluginFactory<any>): unknown {
  const cache = new WeakMap<InternalRuntime, unknown>();

  return new Proxy(Object.create(null), {
    get(_target, prop, receiver) {
      const instance = resolvePlugin(factory, cache);
      const value = Reflect.get(instance as any, prop, receiver);
      return typeof value === "function" ? value.bind(instance as any) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolvePlugin(factory, cache) as any, prop, value);
    },
    has(_target, prop) {
      return Reflect.has(resolvePlugin(factory, cache) as any, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(resolvePlugin(factory, cache) as any);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(resolvePlugin(factory, cache) as any, prop);
    },
  });
}

/**
 * Build lazy proxies for all declared plugins, checking for reserved key conflicts.
 * @internal
 */
export function buildLazyPlugins(
  plugins: Record<string, PluginFactory<any>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, factory] of Object.entries(plugins)) {
    if (RESERVED_KEYS.has(name)) {
      throw new Error(
        `Plugin name "${name}" conflicts with a reserved configure() field. ` +
          `Choose a different key (reserved: ${[...RESERVED_KEYS].join(", ")}).`,
      );
    }
    result[name] = buildLazyPlugin(factory);
  }
  return result;
}
