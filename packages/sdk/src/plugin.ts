/**
 * Plugin authoring helpers.
 *
 * Two concepts live here:
 *
 * 1. **`definePlugin(manifest)`** — declare a plugin manifest for global
 *    registration (matchers, protocol adapters, one-time setup). Consumed by
 *    {@link installPlugin} in `./install-plugin.js`. This is the primary API
 *    for plugin packages like `@glubean/graphql`.
 *
 * 2. **`defineClientFactory(create)`** — declare a lazy client factory for
 *    per-file injection via `configure({ plugins })`. This is the renamed
 *    form of the legacy `definePlugin((runtime) => T)` signature; the name
 *    now describes what it actually is (a client factory, not a plugin).
 *
 * For backward compatibility, `definePlugin` accepts BOTH signatures during
 * Phase 1 of the plugin-system rewrite: passing a function is still supported
 * and routes to `defineClientFactory` with a `@deprecated` hint. Phase 3 will
 * remove the function overload, leaving only the manifest form.
 *
 * @module plugin
 */

import type {
  ClientFactory,
  GlubeanRuntime,
  PluginFactory,
  PluginManifest,
} from "./types.js";

/**
 * Declare a lazy client factory.
 *
 * The factory function receives a `GlubeanRuntime` (vars / secrets / http /
 * template resolution) and returns a client instance. It is invoked lazily on
 * first property access during test execution, not at module load time.
 *
 * Output is consumed by `configure({ plugins: { name: factory } })` for
 * per-file client injection.
 *
 * @param create Factory function receiving the runtime; returns the client.
 * @returns A `ClientFactory<T>` suitable for `configure({ plugins })`.
 *
 * @example Simple client
 * ```ts
 * export const myClient = (opts: { baseUrlKey: string }) =>
 *   defineClientFactory((runtime) => {
 *     const baseUrl = runtime.requireVar(opts.baseUrlKey);
 *     return new MyClient(baseUrl);
 *   });
 * ```
 */
export function defineClientFactory<T>(
  create: (runtime: GlubeanRuntime) => T,
): ClientFactory<T> {
  return { __type: undefined as unknown as T, create };
}

/**
 * Declare a plugin manifest for global registration.
 *
 * The returned manifest is consumed by `installPlugin(...manifests)` at
 * bootstrap time. A manifest can declare custom matchers, protocol adapters,
 * and a one-time `setup()` hook. See {@link PluginManifest}.
 *
 * **Phase 1 backward compatibility**: for migration convenience, passing a
 * function `(runtime) => T` instead of a manifest still works — it is routed
 * to {@link defineClientFactory} and returns a `ClientFactory<T>`. This
 * overload is deprecated and will be removed in a future release.
 *
 * @example Plugin manifest (recommended)
 * ```ts
 * export default definePlugin({
 *   name: "@glubean/graphql",
 *   matchers: { toHaveGraphqlData, toHaveGraphqlErrorCode },
 *   contracts: { graphql: graphqlAdapter },
 * });
 * ```
 *
 * @example Legacy client factory (deprecated)
 * ```ts
 * // Deprecated — use defineClientFactory instead.
 * export const myPlugin = (opts: Opts) =>
 *   definePlugin((runtime) => new MyClient(runtime, opts));
 * ```
 */
export function definePlugin(manifest: PluginManifest): PluginManifest;
/**
 * @deprecated Use `defineClientFactory` instead. This overload is kept for
 * Phase 1 backward compatibility and will be removed in a future release.
 */
export function definePlugin<T>(
  create: (runtime: GlubeanRuntime) => T,
): PluginFactory<T>;
export function definePlugin<T>(
  arg: PluginManifest | ((runtime: GlubeanRuntime) => T),
): PluginManifest | PluginFactory<T> {
  if (typeof arg === "function") {
    // Legacy client-factory usage — route to defineClientFactory.
    return defineClientFactory(arg);
  }
  // Manifest form — return as-is. `installPlugin` will validate the shape.
  return arg;
}
