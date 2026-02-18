/**
 * API Key authentication helper.
 *
 * Supports two modes:
 * - **header** (default): Sends the key as a request header
 * - **query**: Appends the key as a URL query parameter via a `beforeRequest` hook
 *
 * @param prefixUrlVar Var key for the base URL (resolved via `ctx.vars`)
 * @param headerOrParam Header name (e.g., "X-API-Key") or query param name (e.g., "api_key")
 * @param secretKey Secret key for the API key value (resolved via `ctx.secrets`)
 * @param location Where to send the key: "header" (default) or "query"
 * @returns `ConfigureHttpOptions` ready for `configure({ http: ... })`
 *
 * @example Header mode
 * ```ts
 * import { configure } from "@glubean/sdk";
 * import { apiKey } from "@glubean/auth";
 *
 * const { http } = configure({
 *   http: apiKey("base_url", "X-API-Key", "api_key_secret"),
 * });
 * ```
 *
 * @example Query param mode
 * ```ts
 * const { http } = configure({
 *   http: apiKey("base_url", "api_key", "api_key_secret", "query"),
 * });
 * ```
 */
import type { ConfigureHttpOptions } from "@glubean/sdk";

export function apiKey(
  prefixUrlVar: string,
  headerOrParam: string,
  secretKey: string,
  location: "header" | "query" = "header",
): ConfigureHttpOptions {
  if (location === "query") {
    // Query param mode: use beforeRequest hook to append ?param=value
    const MARKER_HEADER = "X-Glubean-ApiKey-Query";
    return {
      prefixUrl: prefixUrlVar,
      headers: {
        [MARKER_HEADER]: `{{${secretKey}}}`,
      },
      hooks: {
        beforeRequest: [
          (request: Request): Request => {
            const keyValue = request.headers.get(MARKER_HEADER);
            if (keyValue) {
              const url = new URL(request.url);
              url.searchParams.set(headerOrParam, keyValue);
              const headers = new Headers(request.headers);
              headers.delete(MARKER_HEADER);
              return new Request(url.toString(), {
                method: request.method,
                headers,
                body: request.body,
                redirect: request.redirect,
                signal: request.signal,
              });
            }
            return request;
          },
        ],
      },
    };
  }

  // Header mode (default): straightforward header with template
  return {
    prefixUrl: prefixUrlVar,
    headers: {
      [headerOrParam]: `{{${secretKey}}}`,
    },
  };
}
