/**
 * @module configure/http
 *
 * Lazy HTTP client builders for configure().
 *
 * - `buildLazyHttp` — creates a proxy that resolves and caches an extended
 *   HttpClient on first call (WeakMap keyed by runtime identity).
 * - `buildPassthroughHttp` — delegates directly to runtime.http when no
 *   http options are declared in configure().
 */

import type { ConfigureHttpOptions, ConfiguredHttpClient, HttpClient } from "../types.js";
import { getRuntime, type InternalRuntime } from "./runtime.js";
import { makeSchemaAwareClient } from "./schema-json.js";
import { resolveTemplate } from "./template.js";

/**
 * Build a lazy HTTP client proxy.
 * On first method call, resolves the config and creates an extended client.
 * Result is cached per runtime identity via WeakMap.
 * @internal
 */
export function buildLazyHttp(httpOptions: ConfigureHttpOptions): ConfiguredHttpClient {
  const cache = new WeakMap<InternalRuntime, HttpClient>();

  function getClient(): HttpClient {
    const runtime = getRuntime();
    let client = cache.get(runtime);
    if (client) return client;

    const extendOptions: Record<string, any> = {};

    if (httpOptions.prefixUrl) {
      extendOptions.prefixUrl = resolveTemplate(
        httpOptions.prefixUrl,
        runtime.vars,
        runtime.secrets,
        runtime.session,
      );
    }

    if (httpOptions.headers) {
      const resolvedHeaders: Record<string, string> = {};
      for (const [name, template] of Object.entries(httpOptions.headers)) {
        resolvedHeaders[name] = resolveTemplate(
          template,
          runtime.vars,
          runtime.secrets,
          runtime.session,
        );
      }
      extendOptions.headers = resolvedHeaders;
    }

    if (httpOptions.searchParams) {
      const resolvedParams: Record<string, string> = {};
      for (const [name, template] of Object.entries(httpOptions.searchParams)) {
        resolvedParams[name] = resolveTemplate(
          template,
          runtime.vars,
          runtime.secrets,
          runtime.session,
        );
      }
      extendOptions.searchParams = resolvedParams;
    }

    if (httpOptions.timeout !== undefined) extendOptions.timeout = httpOptions.timeout;
    if (httpOptions.retry !== undefined) extendOptions.retry = httpOptions.retry;
    if (httpOptions.throwHttpErrors !== undefined) extendOptions.throwHttpErrors = httpOptions.throwHttpErrors;
    if (httpOptions.hooks) extendOptions.hooks = httpOptions.hooks;
    if (httpOptions.redirect !== undefined) extendOptions.redirect = httpOptions.redirect;

    if (typeof process !== "undefined" && process.env?.["GLUBEAN_DEBUG"]) {
      process.stderr.write(`[glubean:debug] configure.getClient extendOptions=${JSON.stringify({ ...extendOptions, headers: "..." })}\n`);
    }

    client = runtime.http.extend(extendOptions);
    cache.set(runtime, client);
    return client;
  }

  // The wrapper decorates every response promise with the schema-aware
  // `.json(schema)` form (issue #32); dispatch stays lazy — `getClient()` is
  // still resolved per call, exactly as before.
  const proxy = makeSchemaAwareClient(getClient);
  (proxy as any)._configuredTimeout = httpOptions.timeout;

  return proxy;
}

/**
 * Build a passthrough HTTP client that delegates directly to runtime.http.
 * Used when configure() is called without http options.
 * @internal
 */
export function buildPassthroughHttp(): ConfiguredHttpClient {
  // Same lazy delegation as before (the runtime is resolved per call, so a
  // missing runtime still throws at call time), plus `.json(schema)`.
  return makeSchemaAwareClient(() => getRuntime().http);
}
