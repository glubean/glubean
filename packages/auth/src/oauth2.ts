import type { ConfigureHttpOptions, HttpRequestOptions } from "@glubean/sdk";
import { rebuildRequest } from "./request.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OAuth2ClientCredentialsOptions {
  /** Base URL — literal or `{{VAR}}` reference */
  prefixUrl: string;
  /** Token endpoint URL — literal or `{{VAR}}` reference */
  tokenUrl: string;
  /** Client ID — literal or `{{SECRET}}` reference */
  clientId: string;
  /** Client secret — literal or `{{SECRET}}` reference */
  clientSecret: string;
  /** OAuth2 scope (optional) */
  scope?: string;
}

export interface OAuth2RefreshTokenOptions {
  /** Base URL — literal or `{{VAR}}` reference */
  prefixUrl: string;
  /** Token endpoint URL — literal or `{{VAR}}` reference */
  tokenUrl: string;
  /** Refresh token — literal or `{{SECRET}}` reference */
  refreshToken: string;
  /** Client ID — literal or `{{SECRET}}` reference */
  clientId: string;
  /** Client secret — literal or `{{SECRET}}` reference (optional) */
  clientSecret?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TOKEN_URL_H = "X-Glubean-OAuth2-TokenUrl";
const CLIENT_ID_H = "X-Glubean-OAuth2-ClientId";
const CLIENT_SECRET_H = "X-Glubean-OAuth2-ClientSecret";
const REFRESH_TOKEN_H = "X-Glubean-OAuth2-RefreshToken";

function cleanMarkers(request: Request, ...names: string[]): Headers {
  const h = new Headers(request.headers);
  for (const n of names) h.delete(n);
  return h;
}

// ── Client Credentials ──────────────────────────────────────────────────────

interface CachedToken { accessToken: string; expiresAt: number }

function clientCredentials(opts: OAuth2ClientCredentialsOptions): ConfigureHttpOptions {
  let cached: CachedToken | null = null;

  return {
    prefixUrl: opts.prefixUrl,
    headers: {
      [TOKEN_URL_H]: opts.tokenUrl,
      [CLIENT_ID_H]: opts.clientId,
      [CLIENT_SECRET_H]: opts.clientSecret,
    },
    hooks: {
      beforeRequest: [
        async ({ request }: { request: Request }): Promise<Request> => {
          const markers = [TOKEN_URL_H, CLIENT_ID_H, CLIENT_SECRET_H] as const;

          if (cached && cached.expiresAt > Date.now() + 30_000) {
            const h = cleanMarkers(request, ...markers);
            h.set("Authorization", `Bearer ${cached.accessToken}`);
            return rebuildRequest(request, h);
          }

          const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: request.headers.get(CLIENT_ID_H) ?? "",
            client_secret: request.headers.get(CLIENT_SECRET_H) ?? "",
          });
          if (opts.scope) body.set("scope", opts.scope);

          const res = await fetch(request.headers.get(TOKEN_URL_H) ?? opts.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          });
          if (!res.ok) {
            throw new Error(`OAuth2 client_credentials failed (${res.status}): ${await res.text()}`);
          }

          const data = (await res.json()) as { access_token: string; expires_in?: number };
          cached = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };

          const h = cleanMarkers(request, ...markers);
          h.set("Authorization", `Bearer ${cached.accessToken}`);
          return rebuildRequest(request, h);
        },
      ],
    },
  };
}

// ── Refresh Token ───────────────────────────────────────────────────────────

function refreshToken(opts: OAuth2RefreshTokenOptions): ConfigureHttpOptions {
  let accessToken: string | null = null;

  const headers: Record<string, string> = {
    [TOKEN_URL_H]: opts.tokenUrl,
    [REFRESH_TOKEN_H]: opts.refreshToken,
    [CLIENT_ID_H]: opts.clientId,
  };
  if (opts.clientSecret) headers[CLIENT_SECRET_H] = opts.clientSecret;

  const allMarkers = [TOKEN_URL_H, REFRESH_TOKEN_H, CLIENT_ID_H, CLIENT_SECRET_H];

  async function fetchToken(request: Request): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: request.headers.get(REFRESH_TOKEN_H) ?? "",
      client_id: request.headers.get(CLIENT_ID_H) ?? "",
    });
    const secret = request.headers.get(CLIENT_SECRET_H);
    if (secret) body.set("client_secret", secret);

    const res = await fetch(request.headers.get(TOKEN_URL_H) ?? opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`OAuth2 refresh_token failed (${res.status}): ${await res.text()}`);
    }
    return ((await res.json()) as { access_token: string }).access_token;
  }

  return {
    prefixUrl: opts.prefixUrl,
    headers,
    hooks: {
      beforeRequest: [
        async ({ request }: { request: Request }): Promise<Request> => {
          if (!accessToken) accessToken = await fetchToken(request);
          const h = cleanMarkers(request, ...allMarkers);
          h.set("Authorization", `Bearer ${accessToken}`);
          return rebuildRequest(request, h);
        },
      ],
      afterResponse: [
        async ({ request, response }: { request: Request; response: Response }): Promise<Response | void> => {
          if (response.status !== 401) return;
          accessToken = await fetchToken(request);
          const h = cleanMarkers(request, ...allMarkers);
          h.set("Authorization", `Bearer ${accessToken}`);
          const bodyBuffer = request.body
            ? await request.clone().arrayBuffer()
            : null;
          return fetch(request.url, {
            method: request.method,
            headers: h,
            body: bodyBuffer,
            redirect: request.redirect,
            signal: request.signal,
            ...(bodyBuffer ? { duplex: "half" as const } : {}),
          } as RequestInit);
        },
      ],
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export const oauth2 = { clientCredentials, refreshToken };
