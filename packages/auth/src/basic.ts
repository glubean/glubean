import type { ConfigureHttpOptions } from "@glubean/sdk";
import { rebuildRequest } from "./request.js";

export interface BasicAuthOptions {
  /** Base URL — literal or `{{VAR}}` reference */
  prefixUrl: string;
  /** Username — literal or `{{SECRET}}` reference */
  username: string;
  /** Password — literal or `{{SECRET}}` reference */
  password: string;
}

const MARKER = "X-Glubean-Basic-Auth";

/**
 * HTTP Basic authentication.
 *
 * Uses a beforeRequest hook to compute `Authorization: Basic base64(user:pass)`
 * from resolved values.
 *
 * @example
 * ```ts
 * basicAuth({ prefixUrl: "{{BASE_URL}}", username: "{{USER}}", password: "{{PASS}}" })
 * ```
 */
export function basicAuth(opts: BasicAuthOptions): ConfigureHttpOptions {
  return {
    prefixUrl: opts.prefixUrl,
    headers: {
      [MARKER]: `${opts.username}:${opts.password}`,
    },
    hooks: {
      beforeRequest: [
        async ({ request }: { request: Request }): Promise<Request> => {
          const credentials = request.headers.get(MARKER);
          if (!credentials) return request;

          const encoded = Buffer.from(credentials).toString("base64");
          const headers = new Headers(request.headers);
          headers.delete(MARKER);
          headers.set("Authorization", `Basic ${encoded}`);
          return rebuildRequest(request, headers);
        },
      ],
    },
  };
}
