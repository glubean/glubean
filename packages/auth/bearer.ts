/**
 * Bearer token authentication helper.
 *
 * Returns a `ConfigureHttpOptions` object with the `Authorization: Bearer` header
 * using `{{template}}` syntax for lazy resolution at runtime.
 *
 * @param prefixUrlVar Var key for the base URL (resolved via `ctx.vars`)
 * @param tokenSecret Secret key for the bearer token (resolved via `ctx.secrets`)
 * @returns `ConfigureHttpOptions` ready for `configure({ http: ... })`
 *
 * @example
 * ```ts
 * import { configure } from "@glubean/sdk";
 * import { bearer } from "@glubean/auth";
 *
 * const { http } = configure({
 *   http: bearer("base_url", "api_token"),
 * });
 * ```
 */
import type { ConfigureHttpOptions } from "@glubean/sdk";

export function bearer(
  prefixUrlVar: string,
  tokenSecret: string,
): ConfigureHttpOptions {
  return {
    prefixUrl: prefixUrlVar,
    headers: {
      Authorization: `Bearer {{${tokenSecret}}}`,
    },
  };
}
