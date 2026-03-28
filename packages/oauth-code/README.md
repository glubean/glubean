# @glubean/oauth-code

OAuth Authorization Code flow plugin for [Glubean](https://glubean.dev) — interactive token acquisition for explore mode.

On first HTTP request, opens the system browser for OAuth login, starts a local callback server on `127.0.0.1`, exchanges the authorization code for tokens, and caches them to disk. Subsequent requests use the cached token, refreshing automatically when expired.

## Install

```bash
npm install @glubean/oauth-code
```

## Quick Start

```ts
import { test, configure } from "@glubean/sdk";
import { oauthCode } from "@glubean/oauth-code";

const { http } = configure({
  http: oauthCode({
    prefixUrl: "https://api.github.com",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: "{{GITHUB_CLIENT_ID}}",
    clientSecret: "{{GITHUB_CLIENT_SECRET}}",
    scopes: ["repo", "read:user"],
  }),
});

export const me = test("github-me", async (ctx) => {
  const res = await http.get("user").json<{ login: string }>();
  ctx.assert(res.login, "got user login");
});
```

First run opens the browser for login. Subsequent runs use the cached token.

## How It Works

```
1. Test calls http.get("/some-endpoint")
2. beforeRequest hook checks for cached token
   ├─ Memory cache valid?     → use it
   ├─ Disk cache valid?       → use it
   ├─ Has refresh_token?      → refresh automatically
   └─ Nothing cached?         → start browser flow:
      a. Start local HTTP server on 127.0.0.1 (random port)
      b. Open system browser with authorize URL
      c. User logs in and authorizes
      d. Provider redirects to 127.0.0.1/callback?code=xxx
      e. Exchange code for access_token + refresh_token
      f. Cache to .glubean/tokens/, close server
3. Set Authorization: Bearer <token> header
4. Request proceeds
```

## API

### `oauthCode(options)` — ConfigureHttpOptions factory

Returns `ConfigureHttpOptions` for use with `configure({ http })`. All string options support `{{template}}` placeholders resolved from Glubean vars and secrets.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prefixUrl` | `string` | — | Base URL for API requests |
| `authorizeUrl` | `string` | — | OAuth authorization endpoint |
| `tokenUrl` | `string` | — | OAuth token endpoint |
| `clientId` | `string` | — | Client ID |
| `clientSecret` | `string?` | — | Client secret (optional for public clients with PKCE) |
| `scopes` | `string[]?` | — | OAuth scopes |
| `pkce` | `boolean` | `true` | Enable PKCE with S256 challenge |
| `cacheDir` | `string` | `".glubean/tokens"` | Token cache directory |
| `redirectUri` | `string?` | — | Override redirect URI (for tunnel setups, see below) |
| `port` | `number?` | random | Fixed port for callback server (required with `redirectUri`) |
| `authorizeParams` | `Record<string, string>?` | — | Extra query parameters for authorize URL |
| `openBrowser` | `(url: string) => void` | system default | Custom browser opener |

## Token Caching

Tokens are cached to `{cacheDir}/{hash}.json` (default: `.glubean/tokens/`). The hash is derived from `clientId + authorizeUrl + scopes` to avoid collisions between providers or different scope sets.

Cache files are written with `0600` permissions (owner read/write only).

Add `.glubean/tokens/` to your `.gitignore`.

## PKCE

PKCE (S256) is enabled by default. This is required by some providers (e.g., Twitter/X) and recommended by RFC 7636 for all public clients. Set `pkce: false` to disable for providers that don't support it.

## Provider Compatibility

| Provider | Localhost redirect | Tunnel needed | Notes |
|----------|-------------------|---------------|-------|
| GitHub | `127.0.0.1` ✅ | No | Port-flexible |
| Google | `127.0.0.1` ✅ | No | Port > 1024 |
| Microsoft | `127.0.0.1` ✅ | No | Port ignored in matching |
| Spotify | `127.0.0.1` ✅ | No | Port-flexible |
| Twitter/X | ❌ | Yes | No loopback redirect support |
| Slack | ❌ | Yes | Requires HTTPS for all redirect URIs |

### Providers that require a tunnel (Twitter/X, Slack)

These providers reject `http://127.0.0.1` as a redirect URI. Use an HTTPS tunnel like [ngrok](https://ngrok.com) to forward traffic to the local callback server:

```bash
# 1. Start a tunnel on a fixed port
ngrok http 9876
# → https://abc123.ngrok-free.app
```

```ts
// 2. Register the ngrok URL as a redirect URI with the provider, then:
const { http } = configure({
  http: oauthCode({
    prefixUrl: "https://api.x.com/2",
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    clientId: "{{TWITTER_CLIENT_ID}}",
    scopes: ["tweet.read", "users.read"],
    redirectUri: "https://abc123.ngrok-free.app/callback",
    port: 9876,
  }),
});
```

The local server still listens on `127.0.0.1:9876`; ngrok tunnels the HTTPS callback back to it.

> **Note:** Postman solves this differently — it hosts its own cloud relay at `oauth.pstmn.io/callback` so users never need a tunnel. A similar Glubean Cloud relay may be added in the future.

## Promoting to CI

This plugin is designed for **explore mode** (interactive local development). When promoting tests to CI:

1. Replace `oauthCode()` with a non-interactive auth method from `@glubean/auth`:
   - `oauth2.clientCredentials()` — if the provider supports it
   - `oauth2.refreshToken()` — with a pre-provisioned refresh token
   - `bearer()` — with a pre-provisioned access token
2. Test logic stays the same — only the `configure({ http })` line changes.

## Scope

This is a v1 focused on the authorization code flow for explore mode. Not included:

- Device code flow (RFC 8628)
- Implicit grant (deprecated)
- Token revocation
- Multi-account support
- Custom TLS / proxy configuration

## License

MIT
