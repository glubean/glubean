# Configure — Shared HTTP Clients, Vars, Secrets, Plugins

## Basic API client

```typescript
// config/api.ts
import { configure } from "@glubean/sdk";

export const { http: api, vars, secrets } = configure({
  vars: { user: "GITHUB_USER" },       // .env → property mapping
  secrets: { token: "API_KEY" },        // .env.secrets → property mapping
  http: {
    prefixUrl: "BASE_URL",             // Env var name (resolved at runtime)
    headers: {
      Authorization: "Bearer {{API_KEY}}",  // {{var}} interpolation from secrets
      Accept: "application/json",
    },
    timeout: 15000,
    retry: 2,
  },
});
```

`.env`:
```
BASE_URL=https://api.example.com
GITHUB_USER=glubean
```

`.env.secrets`:
```
API_KEY=sk_live_xxx
```

## Public + Authenticated clients (same API, different auth)

```typescript
// config/github-api.ts
import { configure } from "@glubean/sdk";

// Public — no token needed
export const { http: githubApi, vars: githubVars } = configure({
  vars: {
    user: "GITHUB_USER",
    repo: "GITHUB_REPO",
    searchQuery: "GITHUB_SEARCH_QUERY",
  },
  http: {
    prefixUrl: "GITHUB_API",
    headers: { Accept: "application/vnd.github+json" },
  },
});

// Authenticated — requires GITHUB_TOKEN in .env.secrets
export const { http: githubAuthApi } = configure({
  secrets: { token: "GITHUB_TOKEN" },
  http: {
    prefixUrl: "GITHUB_API",
    headers: {
      Authorization: "Bearer {{GITHUB_TOKEN}}",
      Accept: "application/vnd.github+json",
    },
  },
});
```

## With browser plugin

```typescript
// config/browser.ts
import { test, configure } from "@glubean/sdk";
import { browser } from "@glubean/browser";
import type { InstrumentedPage } from "@glubean/browser";

export const { chrome } = configure({
  plugins: {
    chrome: browser({
      launch: true,
      launchOptions: { headless: true },
    }),
  },
});

// Per-test page fixture — auto-closed after test
export const browserTest = test.extend({
  page: async (ctx, use: (instance: InstrumentedPage) => Promise<void>) => {
    const pg = await chrome.newPage(ctx);
    try { await use(pg); }
    finally { await pg.close(); }
  },
});
```

## With custom plugin (AI example)

```typescript
// config/ai.ts
import { configure, definePlugin } from "@glubean/sdk";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ZodType } from "zod";

export const { ai } = configure({
  plugins: {
    ai: definePlugin((rt) => {
      const openai = createOpenAI({
        apiKey: rt.requireSecret("OPENAI_API_KEY"),
      });
      return {
        generate: <T>(schema: ZodType<T>, prompt: string, model = "gpt-4o-mini") =>
          generateObject({ model: openai(model), schema, prompt }),
      };
    }),
  },
});
```

## Anti-patterns

```typescript
// ❌ Hardcoded URL
const res = await fetch("https://api.example.com/users");

// ✅ Use configured client
const res = await api.get("users").json();

// ❌ Hardcoded secret
headers: { Authorization: "Bearer sk_live_xxx" }

// ✅ Use secrets interpolation or require
headers: { Authorization: "Bearer {{API_KEY}}" }
// or in test: ctx.secrets.require("API_KEY")

// ❌ Inline const for base URL
const BASE_URL = "https://api.example.com";

// ✅ Put in .env
// .env: BASE_URL=https://api.example.com
// configure: http: { prefixUrl: "BASE_URL" }
```
