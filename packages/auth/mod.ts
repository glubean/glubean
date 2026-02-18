/**
 * Auth helpers for Glubean tests.
 *
 * Provides authentication utilities for common patterns:
 *
 * - **Static auth** (Hook 2): `bearer()`, `basicAuth()`, `apiKey()` return
 *   `ConfigureHttpOptions` with pre-configured headers.
 *
 * - **OAuth 2.0** (Hook 4): `oauth2.clientCredentials()` and `oauth2.refreshToken()`
 *   return `ConfigureHttpOptions` with HTTP middleware hooks for token management.
 *
 * - **Dynamic login** (Hook 3): `withLogin()` is a builder transform that adds
 *   a login step and passes an `authedHttp` client to subsequent steps.
 *
 * ## Quick Start
 *
 * ```ts
 * import { configure } from "@glubean/sdk";
 * import { bearer } from "@glubean/auth";
 *
 * const { http } = configure({
 *   http: bearer("base_url", "api_token"),
 * });
 * ```
 *
 * @module auth
 */

export { bearer } from "./bearer.ts";
export { basicAuth } from "./basic.ts";
export { apiKey } from "./api_key.ts";
export { oauth2 } from "./oauth2.ts";
export type {
  OAuth2ClientCredentialsOptions,
  OAuth2RefreshTokenOptions,
} from "./oauth2.ts";
export { withLogin } from "./with_login.ts";
export type { WithLoginOptions } from "./with_login.ts";
