/**
 * HTTP Basic authentication helper.
 *
 * Uses a `beforeRequest` hook to compute the `Authorization: Basic base64(user:pass)`
 * header at request time from resolved secret values.
 *
 * @param prefixUrlVar Var key for the base URL (resolved via `ctx.vars`)
 * @param usernameSecret Secret key for the username
 * @param passwordSecret Secret key for the password
 * @returns `ConfigureHttpOptions` ready for `configure({ http: ... })`
 *
 * @example
 * ```ts
 * import { configure } from "@glubean/sdk";
 * import { basicAuth } from "@glubean/auth";
 *
 * const { http } = configure({
 *   http: basicAuth("base_url", "username", "password"),
 * });
 * ```
 */
import type { ConfigureHttpOptions } from "@glubean/sdk";
import { encodeBase64 } from "@std/encoding/base64";

export function basicAuth(
  prefixUrlVar: string,
  usernameSecret: string,
  passwordSecret: string,
): ConfigureHttpOptions {
  // Store the secret template keys for resolution in the beforeRequest hook.
  // The hook receives the request after configure() has resolved headers,
  // but we need to resolve secrets ourselves since Basic auth requires
  // combining two secrets into one base64-encoded value.
  //
  // We use a special header to pass template keys through to the hook,
  // then replace it with the actual Basic auth header.
  const MARKER_HEADER = "X-Glubean-Basic-Auth";

  return {
    prefixUrl: prefixUrlVar,
    headers: {
      [MARKER_HEADER]: `{{${usernameSecret}}}:{{${passwordSecret}}}`,
    },
    hooks: {
      beforeRequest: [
        (request: Request): Request => {
          const credentials = request.headers.get(MARKER_HEADER);
          if (credentials) {
            const encoded = encodeBase64(credentials);
            const headers = new Headers(request.headers);
            headers.delete(MARKER_HEADER);
            headers.set("Authorization", `Basic ${encoded}`);
            return new Request(request.url, {
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
