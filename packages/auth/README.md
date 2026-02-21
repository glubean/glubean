# @glubean/auth

> **Experimental** — API may change before 1.0. Feedback welcome.

Authentication helpers for [Glubean](https://github.com/glubean/glubean) tests. Covers the most common API auth
patterns: bearer tokens, basic auth, API keys, OAuth 2.0 client credentials / refresh token, and dynamic login flows.

## Install

```ts
import { bearer } from "jsr:@glubean/auth";
```

Or with the import map:

```jsonc
// deno.json
{
  "imports": {
    "@glubean/auth": "jsr:@glubean/auth@^0.11.0"
  }
}
```

## Quick Start

```ts
import { configure, test } from "@glubean/sdk";
import { bearer } from "@glubean/auth";

const { http } = configure({
  http: bearer("base_url", "api_token"),
});

export const getUser = test("get-user", async (ctx) => {
  const res = await http.get("/users/1").json();
  ctx.expect(res.id).toBe(1);
});
```

## Auth Helpers

### `bearer(prefixUrlVar, tokenSecret)`

Sets `Authorization: Bearer <token>` header using `{{template}}` variable resolution.

```ts
import { configure } from "@glubean/sdk";
import { bearer } from "@glubean/auth";

const { http } = configure({
  http: bearer("base_url", "api_token"),
  // Reads base_url from vars, api_token from secrets
});
```

### `basicAuth(prefixUrlVar, usernameVar, passwordSecret)`

Sets `Authorization: Basic <base64>` header.

```ts
import { basicAuth } from "@glubean/auth";

const { http } = configure({
  http: basicAuth("base_url", "username", "password"),
});
```

### `apiKey(prefixUrlVar, keySecret, options?)`

Injects an API key as a header or query parameter.

```ts
import { apiKey } from "@glubean/auth";

// As a header (default: "X-API-Key")
const { http } = configure({
  http: apiKey("base_url", "api_key", { header: "X-Api-Key" }),
});

// As a query parameter
const { http: http2 } = configure({
  http: apiKey("base_url", "api_key", { queryParam: "api_key" }),
});
```

### `oauth2.clientCredentials(options)`

OAuth 2.0 Client Credentials flow — fetches and caches an access token, refreshing when expired.

```ts
import { oauth2 } from "@glubean/auth";

const { http } = configure({
  http: oauth2.clientCredentials({
    tokenUrl: "{{token_url}}",
    clientId: "{{client_id}}",
    clientSecret: "client_secret",
  }),
});
```

### `oauth2.refreshToken(options)`

OAuth 2.0 Refresh Token flow — uses an existing refresh token to obtain access tokens.

```ts
import { oauth2 } from "@glubean/auth";

const { http } = configure({
  http: oauth2.refreshToken({
    tokenUrl: "{{token_url}}",
    refreshToken: "refresh_token",
    clientId: "{{client_id}}",
  }),
});
```

### `withLogin(builder, options)`

Dynamic login builder transform — adds a login step that POSTs credentials, extracts a token from the response, and
passes an authenticated HTTP client to subsequent test steps.

```ts
import { test } from "@glubean/sdk";
import { withLogin } from "@glubean/auth";

export const userFlow = withLogin(
  test("user-flow"),
  {
    endpoint: "{{base_url}}/auth/login",
    credentials: {
      username: "{{username}}",
      password: "{{password}}",
    },
    extractToken: (body) => body.access_token,
    headerName: "Authorization",
    headerFormat: (token) => `Bearer ${token}`,
  },
).step("get profile", async (ctx, { authedHttp }) => {
  const profile = await authedHttp.get("/me").json();
  ctx.expect(profile.email).toBeDefined();
});
```

## License

MIT
