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

import type { ConfigureHttpOptions, HttpClient } from "../types.js";
import { getRuntime, type InternalRuntime } from "./runtime.js";
import { resolveTemplate } from "./template.js";

/**
 * Build a lazy HTTP client proxy.
 * On first method call, resolves the config and creates an extended client.
 * Result is cached per runtime identity via WeakMap.
 * @internal
 */
export function buildLazyHttp(httpOptions: ConfigureHttpOptions): HttpClient {
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

  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

  const proxy: any = function (url: string | URL | Request, options?: any) {
    return getClient()(url, options);
  };

  for (const method of HTTP_METHODS) {
    proxy[method] = (url: string | URL | Request, options?: any) => getClient()[method](url, options);
  }

  proxy.extend = (options: any) => getClient().extend(options);
  (proxy as any)._configuredTimeout = httpOptions.timeout;

  return proxy as HttpClient;
}

/**
 * Build a passthrough HTTP client that delegates directly to runtime.http.
 * Used when configure() is called without http options.
 * @internal
 */
export function buildPassthroughHttp(): HttpClient {
  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

  const proxy: any = function (url: string | URL | Request, options?: any) {
    return getRuntime().http(url, options);
  };

  for (const method of HTTP_METHODS) {
    proxy[method] = (url: string | URL | Request, options?: any) => getRuntime().http[method](url, options);
  }

  proxy.extend = (options: any) => getRuntime().http.extend(options);

  return proxy as HttpClient;
}
