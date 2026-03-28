import type { ConfigureHttpOptions, HttpRequestOptions } from "@glubean/sdk";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OAuthCodeOptions {
  /** Base URL for API requests — var key or literal */
  prefixUrl: string;
  /** OAuth authorization endpoint URL */
  authorizeUrl: string;
  /** OAuth token endpoint URL */
  tokenUrl: string;
  /** Client ID — literal or `{{SECRET}}` reference */
  clientId: string;
  /** Client secret — literal or `{{SECRET}}` reference (optional for public clients with PKCE) */
  clientSecret?: string;
  /** OAuth scopes */
  scopes?: string[];
  /** Enable PKCE with S256 (default: true) */
  pkce?: boolean;
  /** Token cache directory (default: ".glubean/tokens") */
  cacheDir?: string;
  /**
   * Override the redirect URI sent to the provider.
   * Use with `port` for providers that reject `http://127.0.0.1` (e.g., Slack, Twitter/X).
   * The local callback server still listens on 127.0.0.1; set this to the external URL
   * that tunnels traffic back (e.g., an ngrok HTTPS URL).
   *
   * @example ngrok tunnel
   * ```ts
   * // 1. Run: ngrok http 9876
   * // 2. Register https://abc123.ngrok.io/callback with the provider
   * oauthCode({
   *   redirectUri: "https://abc123.ngrok.io/callback",
   *   port: 9876,
   *   ...
   * })
   * ```
   */
  redirectUri?: string;
  /** Fixed port for the local callback server (default: random). Required when using `redirectUri` with a tunnel. */
  port?: number;
  /** Extra query parameters for the authorize URL */
  authorizeParams?: Record<string, string>;
  /** Custom function to open a URL in the browser (default: system browser via `open`/`xdg-open`) */
  openBrowser?: (url: string) => void;
}

// ── Marker Headers ───────────────────────────────────────────────────────────

const AUTH_URL_H = "X-Glubean-OAuthCode-AuthUrl";
const TOKEN_URL_H = "X-Glubean-OAuthCode-TokenUrl";
const CLIENT_ID_H = "X-Glubean-OAuthCode-ClientId";
const CLIENT_SECRET_H = "X-Glubean-OAuthCode-ClientSecret";

const ALL_MARKERS = [AUTH_URL_H, TOKEN_URL_H, CLIENT_ID_H, CLIENT_SECRET_H];

function cleanMarkers(request: Request): Headers {
  const h = new Headers(request.headers);
  for (const m of ALL_MARKERS) h.delete(m);
  return h;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── Request Rebuild ──────────────────────────────────────────────────────────

async function rebuildRequest(
  request: Request,
  headers: Headers,
): Promise<Request> {
  const bodyBuffer = request.body
    ? await request.clone().arrayBuffer()
    : null;

  return new Request(request.url, {
    method: request.method,
    headers,
    body: bodyBuffer,
    redirect: request.redirect,
    signal: request.signal,
    ...(bodyBuffer ? { duplex: "half" as const } : {}),
  } as RequestInit);
}

// ── Token Cache ──────────────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

function cacheKey(clientId: string, authorizeUrl: string, scopes?: string): string {
  return createHash("sha256")
    .update(`${clientId}:${authorizeUrl}:${scopes ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

async function readCache(dir: string, key: string): Promise<CachedToken | null> {
  try {
    const data = await readFile(join(dir, `${key}.json`), "utf-8");
    return JSON.parse(data) as CachedToken;
  } catch {
    return null;
  }
}

async function writeCache(dir: string, key: string, token: CachedToken): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.json`), JSON.stringify(token, null, 2), { mode: 0o600 });
}

// ── Local Callback Server ────────────────────────────────────────────────────

interface CallbackServer {
  port: number;
  waitForCode(expectedState: string): Promise<string>;
  close(): void;
}

function startCallbackServer(port?: number): Promise<CallbackServer> {
  return new Promise((resolveServer) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    let codePromise: Promise<string> | null = null;
    let expectedState: string | null = null;

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html("Authorization Failed", `Error: ${desc}. You can close this window.`));
        rejectCode(new Error(`OAuth authorization failed: ${desc}`));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html("Missing Code", "No authorization code received."));
        rejectCode(new Error("OAuth callback missing code parameter"));
        return;
      }

      if (expectedState && state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html("Invalid State", "State mismatch — possible CSRF attack."));
        rejectCode(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html("Authorization Successful", "You can close this window."));
      resolveCode(code);
    });

    server.listen(port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolveServer({
        port: addr.port,
        waitForCode(state: string) {
          if (!codePromise) {
            expectedState = state;
            codePromise = new Promise<string>((res, rej) => {
              resolveCode = res;
              rejectCode = rej;
            });
          }
          return codePromise;
        },
        close: () => server.close(),
      });
    });
  });
}

function html(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body><h2>${title}</h2><p>${message}</p></body></html>`;
}

// ── Browser Open ─────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}

// ── Token Exchange ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function exchangeCode(params: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);
  if (params.codeVerifier) body.set("code_verifier", params.codeVerifier);

  const res = await fetch(params.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(params: {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);

  const res = await fetch(params.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`OAuth token refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * OAuth Authorization Code flow for Glubean explore mode.
 *
 * On first HTTP request, opens the system browser for OAuth login,
 * starts a local server to receive the callback, exchanges the code
 * for tokens, and caches them to disk. Subsequent requests use the
 * cached token, refreshing automatically when expired.
 *
 * @example
 * ```ts
 * import { oauthCode } from "@glubean/oauth-code";
 *
 * const { http } = configure({
 *   http: oauthCode({
 *     prefixUrl: "https://api.github.com",
 *     authorizeUrl: "https://github.com/login/oauth/authorize",
 *     tokenUrl: "https://github.com/login/oauth/access_token",
 *     clientId: "{{GITHUB_CLIENT_ID}}",
 *     clientSecret: "{{GITHUB_CLIENT_SECRET}}",
 *     scopes: ["repo", "read:user"],
 *   }),
 * });
 * ```
 */
export function oauthCode(opts: OAuthCodeOptions): ConfigureHttpOptions {
  const usePkce = opts.pkce !== false;
  const cacheDir = opts.cacheDir ?? ".glubean/tokens";
  const scopes = opts.scopes?.join(" ");
  const open = opts.openBrowser ?? openBrowser;

  let cached: CachedToken | null = null;
  let diskChecked = false;
  let inflight: Promise<CachedToken> | null = null;

  const headers: Record<string, string> = {
    [AUTH_URL_H]: opts.authorizeUrl,
    [TOKEN_URL_H]: opts.tokenUrl,
    [CLIENT_ID_H]: opts.clientId,
  };
  if (opts.clientSecret) headers[CLIENT_SECRET_H] = opts.clientSecret;

  /** Read resolved marker values from the request (template-resolved by SDK). */
  function readMarkers(request: Request) {
    return {
      authorizeUrl: request.headers.get(AUTH_URL_H) ?? opts.authorizeUrl,
      tokenUrl: request.headers.get(TOKEN_URL_H) ?? opts.tokenUrl,
      clientId: request.headers.get(CLIENT_ID_H) ?? opts.clientId,
      clientSecret: request.headers.get(CLIENT_SECRET_H) ?? undefined,
    };
  }

  function toCache(data: TokenResponse, prev?: CachedToken): CachedToken {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? prev?.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }

  async function tryRefresh(
    tokenUrl: string,
    refreshToken: string,
    clientId: string,
    clientSecret?: string,
  ): Promise<CachedToken | null> {
    try {
      const data = await refreshAccessToken({ tokenUrl, refreshToken, clientId, clientSecret });
      return toCache(data, cached ?? undefined);
    } catch {
      return null;
    }
  }

  async function acquireToken(request: Request): Promise<CachedToken> {
    const m = readMarkers(request);
    const key = cacheKey(m.clientId, m.authorizeUrl, scopes);

    // 1. Memory cache — still valid
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached;
    }

    // 2. Disk cache
    if (!diskChecked) {
      diskChecked = true;
      const disk = await readCache(cacheDir, key);
      if (disk) {
        if (disk.expiresAt > Date.now() + 30_000) {
          cached = disk;
          return cached;
        }
        // Expired but has refresh token
        if (disk.refreshToken) {
          const refreshed = await tryRefresh(m.tokenUrl, disk.refreshToken, m.clientId, m.clientSecret);
          if (refreshed) {
            cached = refreshed;
            await writeCache(cacheDir, key, cached);
            return cached;
          }
        }
      }
    }

    // 3. Memory cache has refresh token
    if (cached?.refreshToken) {
      const refreshed = await tryRefresh(m.tokenUrl, cached.refreshToken, m.clientId, m.clientSecret);
      if (refreshed) {
        cached = refreshed;
        await writeCache(cacheDir, key, cached);
        return cached;
      }
    }

    // 4. Browser flow
    const server = await startCallbackServer(opts.port);
    const redirectUri = opts.redirectUri ?? `http://127.0.0.1:${server.port}/callback`;
    const state = randomBytes(16).toString("hex");

    const authUrl = new URL(m.authorizeUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", m.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    if (scopes) authUrl.searchParams.set("scope", scopes);

    // Extra authorize params
    if (opts.authorizeParams) {
      for (const [k, v] of Object.entries(opts.authorizeParams)) {
        authUrl.searchParams.set(k, v);
      }
    }

    let codeVerifier: string | undefined;
    if (usePkce) {
      codeVerifier = generateCodeVerifier();
      authUrl.searchParams.set("code_challenge", generateCodeChallenge(codeVerifier));
      authUrl.searchParams.set("code_challenge_method", "S256");
    }

    process.stderr.write(
      `\n  OAuth login required. Opening browser...\n  ${authUrl.toString()}\n\n`,
    );
    open(authUrl.toString());

    try {
      const code = await server.waitForCode(state);
      const data = await exchangeCode({
        tokenUrl: m.tokenUrl,
        code,
        redirectUri,
        clientId: m.clientId,
        clientSecret: m.clientSecret,
        codeVerifier,
      });
      cached = toCache(data);
      await writeCache(cacheDir, key, cached);
      return cached;
    } finally {
      server.close();
    }
  }

  /** Serialize token acquisition — concurrent callers share the same promise. */
  function ensureToken(request: Request): Promise<CachedToken> {
    // Fast path: valid memory cache, no serialization needed
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return Promise.resolve(cached);
    }
    // Slow path: serialize so only one browser flow / refresh runs at a time
    if (inflight) return inflight;
    inflight = acquireToken(request).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    prefixUrl: opts.prefixUrl,
    headers,
    hooks: {
      beforeRequest: [
        async (request: Request): Promise<Request> => {
          const token = await ensureToken(request);
          const h = cleanMarkers(request);
          h.set("Authorization", `Bearer ${token.accessToken}`);
          return rebuildRequest(request, h);
        },
      ],
      afterResponse: [
        async (
          request: Request,
          _options: HttpRequestOptions,
          response: Response,
        ): Promise<Response | void> => {
          if (response.status !== 401 || !cached?.refreshToken) return;

          const m = readMarkers(request);
          const refreshed = await tryRefresh(
            m.tokenUrl,
            cached.refreshToken!,
            m.clientId,
            m.clientSecret,
          );
          if (!refreshed) return;

          cached = refreshed;
          const key = cacheKey(m.clientId, m.authorizeUrl, scopes);
          await writeCache(cacheDir, key, cached);

          // Retry the original request with new token
          const h = cleanMarkers(request);
          h.set("Authorization", `Bearer ${refreshed.accessToken}`);
          const rebuilt = await rebuildRequest(request, h);
          const bodyBuffer = request.body
            ? await request.clone().arrayBuffer()
            : null;
          return fetch(rebuilt.url, {
            method: rebuilt.method,
            headers: h,
            body: bodyBuffer,
            redirect: rebuilt.redirect,
            signal: rebuilt.signal,
            ...(bodyBuffer ? { duplex: "half" as const } : {}),
          } as RequestInit);
        },
      ],
    },
  };
}
