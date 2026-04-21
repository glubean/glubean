/**
 * Plugin authoring helpers.
 *
 * Two APIs live here, one per concept:
 *
 * 1. **`definePlugin(manifest)`** — declare a plugin manifest for global
 *    registration (matchers, protocol adapters, one-time setup). Consumed by
 *    {@link installPlugin} in `./install-plugin.js`. This is the primary API
 *    for plugin packages like `@glubean/graphql` and `@glubean/grpc`.
 *
 * 2. **`defineClientFactory(create)`** — declare a lazy client factory for
 *    per-file injection via `configure({ plugins })`. This is what the
 *    legacy `definePlugin((runtime) => T)` signature used to do; the name
 *    has been corrected to describe what it actually is (a client factory,
 *    not a plugin).
 *
 * The legacy `definePlugin((runtime) => T)` overload was removed in Phase 3.
 * Migrate call sites to `defineClientFactory((runtime) => T)` for the same
 * behavior and better naming.
 *
 * @module plugin
 */

import type {
  ClientFactory,
  GlubeanRuntime,
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
 * @example Plugin manifest
 * ```ts
 * export default definePlugin({
 *   name: "@glubean/graphql",
 *   matchers: { toHaveGraphqlData, toHaveGraphqlErrorCode },
 *   contracts: { graphql: graphqlAdapter },
 *   setup() {
 *     // Optional one-time registration work
 *   },
 * });
 * ```
 */
export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest;
}
