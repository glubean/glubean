/**
 * OAuth 2.0 authentication helpers.
 *
 * - `oauth2.clientCredentials()` — Fetches and caches an access token via the
 *   client credentials grant, injecting `Authorization: Bearer <token>` into
 *   every request through a `beforeRequest` hook.
 *
 * - `oauth2.refreshToken()` — Uses a refresh token flow: detects 401 responses
 *   via an `afterResponse` hook, refreshes the token, and retries the request.
 *
 * @module oauth2
 */
import type { ConfigureHttpOptions } from "@glubean/sdk";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for the OAuth 2.0 Client Credentials grant.
 */
export interface OAuth2ClientCredentialsOptions {
  /** Var key for the API base URL */
  prefixUrl: string;
  /**
   * Var key whose runtime value is the token endpoint URL.
   * Resolved via `ctx.vars` at request time, just like `prefixUrl`.
   */
  tokenUrl: string;
  /** Secret key for the OAuth client ID */
  clientId: string;
  /** Secret key for the OAuth client secret */
  clientSecret: string;
  /** OAuth scope (optional) */
  scope?: string;
}

/**
 * Options for the OAuth 2.0 Refresh Token flow.
 */
export interface OAuth2RefreshTokenOptions {
  /** Var key for the API base URL */
  prefixUrl: string;
  /**
   * Var key whose runtime value is the token endpoint URL.
   * Resolved via `ctx.vars` at request time, just like `prefixUrl`.
   */
  tokenUrl: string;
  /** Secret key for the refresh token */
  refreshToken: string;
  /** Secret key for the OAuth client ID */
  clientId: string;
  /** Secret key for the OAuth client secret (optional for public clients) */
  clientSecret?: string;
}

// =============================================================================
// Token cache (shared within a single configure() call)
// =============================================================================

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// =============================================================================
// Client Credentials
// =============================================================================

function createClientCredentialsOptions(
  options: OAuth2ClientCredentialsOptions,
): ConfigureHttpOptions {
  const {
    prefixUrl,
    tokenUrl,
    clientId: clientIdSecret,
    clientSecret: clientSecretSecret,
    scope,
  } = options;

  let cached: CachedToken | null = null;

  // Marker header to carry resolved secret values to the beforeRequest hook
  const TOKEN_URL_HEADER = "X-Glubean-OAuth2-TokenUrl";
  const CLIENT_ID_HEADER = "X-Glubean-OAuth2-ClientId";
  const CLIENT_SECRET_HEADER = "X-Glubean-OAuth2-ClientSecret";

  const headers: Record<string, string> = {
    [TOKEN_URL_HEADER]: `{{${tokenUrl}}}`,
    [CLIENT_ID_HEADER]: `{{${clientIdSecret}}}`,
    [CLIENT_SECRET_HEADER]: `{{${clientSecretSecret}}}`,
  };

  return {
    prefixUrl,
    headers,
    hooks: {
      beforeRequest: [
        async (request: Request): Promise<Request> => {
          const now = Date.now();

          // Check if we have a valid cached token (with 30s buffer)
          if (cached && cached.expiresAt > now + 30_000) {
            const h = new Headers(request.headers);
            h.delete(TOKEN_URL_HEADER);
            h.delete(CLIENT_ID_HEADER);
            h.delete(CLIENT_SECRET_HEADER);
            h.set("Authorization", `Bearer ${cached.accessToken}`);
            return new Request(request.url, {
              method: request.method,
              headers: h,
              body: request.body,
              redirect: request.redirect,
              signal: request.signal,
            });
          }

          // Extract resolved values from marker headers
          const resolvedTokenUrl = request.headers.get(TOKEN_URL_HEADER) ?? tokenUrl;
          const resolvedClientId = request.headers.get(CLIENT_ID_HEADER) ?? "";
          const resolvedClientSecret = request.headers.get(CLIENT_SECRET_HEADER) ?? "";

          // Fetch new token
          const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: resolvedClientId,
            client_secret: resolvedClientSecret,
          });
          if (scope) {
            body.set("scope", scope);
          }

          const tokenResponse = await fetch(resolvedTokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });

          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            throw new Error(
              `OAuth2 client_credentials token request failed (${tokenResponse.status}): ${errorText}`,
            );
          }

          const tokenData = (await tokenResponse.json()) as {
            access_token: string;
            expires_in?: number;
            token_type?: string;
          };

          // Cache the token
          const expiresIn = tokenData.expires_in ?? 3600;
          cached = {
            accessToken: tokenData.access_token,
            expiresAt: now + expiresIn * 1000,
          };

          // Build new request with auth header, without marker headers
          const h = new Headers(request.headers);
          h.delete(TOKEN_URL_HEADER);
          h.delete(CLIENT_ID_HEADER);
          h.delete(CLIENT_SECRET_HEADER);
          h.set("Authorization", `Bearer ${cached.accessToken}`);
          return new Request(request.url, {
            method: request.method,
            headers: h,
            body: request.body,
            redirect: request.redirect,
            signal: request.signal,
          });
        },
      ],
    },
  };
}

// =============================================================================
// Refresh Token
// =============================================================================

function createRefreshTokenOptions(
  options: OAuth2RefreshTokenOptions,
): ConfigureHttpOptions {
  const {
    prefixUrl,
    tokenUrl,
    refreshToken: refreshTokenSecret,
    clientId: clientIdSecret,
    clientSecret: clientSecretSecret,
  } = options;

  let accessToken: string | null = null;

  // Marker headers for template resolution
  const TOKEN_URL_HEADER = "X-Glubean-OAuth2-TokenUrl";
  const REFRESH_TOKEN_HEADER = "X-Glubean-OAuth2-RefreshToken";
  const CLIENT_ID_HEADER = "X-Glubean-OAuth2-ClientId";
  const CLIENT_SECRET_HEADER = "X-Glubean-OAuth2-ClientSecret";

  const headers: Record<string, string> = {
    [TOKEN_URL_HEADER]: `{{${tokenUrl}}}`,
    [REFRESH_TOKEN_HEADER]: `{{${refreshTokenSecret}}}`,
    [CLIENT_ID_HEADER]: `{{${clientIdSecret}}}`,
  };
  if (clientSecretSecret) {
    headers[CLIENT_SECRET_HEADER] = `{{${clientSecretSecret}}}`;
  }

  async function fetchToken(request: Request): Promise<string> {
    const resolvedTokenUrl = request.headers.get(TOKEN_URL_HEADER) ?? tokenUrl;
    const resolvedRefreshToken = request.headers.get(REFRESH_TOKEN_HEADER) ?? "";
    const resolvedClientId = request.headers.get(CLIENT_ID_HEADER) ?? "";
    const resolvedClientSecret = request.headers.get(CLIENT_SECRET_HEADER) ?? "";

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: resolvedRefreshToken,
      client_id: resolvedClientId,
    });
    if (resolvedClientSecret) {
      body.set("client_secret", resolvedClientSecret);
    }

    const tokenResponse = await fetch(resolvedTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(
        `OAuth2 refresh_token request failed (${tokenResponse.status}): ${errorText}`,
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
    };

    return tokenData.access_token;
  }

  function cleanHeaders(request: Request): Headers {
    const h = new Headers(request.headers);
    h.delete(TOKEN_URL_HEADER);
    h.delete(REFRESH_TOKEN_HEADER);
    h.delete(CLIENT_ID_HEADER);
    h.delete(CLIENT_SECRET_HEADER);
    return h;
  }

  return {
    prefixUrl,
    headers,
    hooks: {
      beforeRequest: [
        async (request: Request): Promise<Request> => {
          // If we don't have a token yet, fetch one proactively
          if (!accessToken) {
            accessToken = await fetchToken(request);
          }

          const h = cleanHeaders(request);
          h.set("Authorization", `Bearer ${accessToken}`);
          return new Request(request.url, {
            method: request.method,
            headers: h,
            body: request.body,
            redirect: request.redirect,
            signal: request.signal,
          });
        },
      ],
      afterResponse: [
        async (
          request: Request,
          _options: import("@glubean/sdk").HttpRequestOptions,
          response: Response,
        ): Promise<Response | void> => {
          if (response.status !== 401) return;

          // Token expired — refresh and retry
          accessToken = await fetchToken(request);

          const h = cleanHeaders(request);
          h.set("Authorization", `Bearer ${accessToken}`);

          return fetch(request.url, {
            method: request.method,
            headers: h,
            body: request.body,
            redirect: request.redirect,
            signal: request.signal,
          });
        },
      ],
    },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * OAuth 2.0 authentication helpers.
 *
 * @example Client Credentials grant
 * ```ts
 * import { configure } from "@glubean/sdk";
 * import { oauth2 } from "@glubean/auth";
 *
 * const { http } = configure({
 *   http: oauth2.clientCredentials({
 *     prefixUrl: "base_url",
 *     tokenUrl: "token_url",
 *     clientId: "client_id",
 *     clientSecret: "client_secret",
 *     scope: "read:users",
 *   }),
 * });
 * ```
 *
 * @example Refresh Token flow
 * ```ts
 * const { http } = configure({
 *   http: oauth2.refreshToken({
 *     prefixUrl: "base_url",
 *     tokenUrl: "token_url",
 *     refreshToken: "refresh_token",
 *     clientId: "client_id",
 *   }),
 * });
 * ```
 */
export const oauth2 = {
  clientCredentials: createClientCredentialsOptions,
  refreshToken: createRefreshTokenOptions,
};
