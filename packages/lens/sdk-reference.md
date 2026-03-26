# Glubean SDK Reference

Quick reference for `@glubean/sdk` and `@glubean/browser`. For full type details, check the source via go-to-definition.

## Imports

```typescript
import { test, configure, definePlugin, defineSession, fromDir, fromCsv, fromJson, fromYaml, fromJsonl } from "@glubean/sdk";
import { browser } from "@glubean/browser";
import type { InstrumentedPage } from "@glubean/browser";
```

---

## test()

```typescript
// Quick mode
test(id: string | TestMeta, fn: (ctx: TestContext) => Promise<void>): Test

// Builder mode (multi-step)
test(id: string | TestMeta): TestBuilder

// Modifiers
test.only(...)   // Run only this test
test.skip(...)   // Skip this test
```

### TestMeta

```typescript
{
  id: string                    // Unique kebab-case ID
  name?: string                 // Human-readable name
  tags?: string | string[]      // e.g. ["smoke", "api"]
  timeout?: number              // Default 30000ms
}
```

### TestBuilder (multi-step)

```typescript
test("my-test")
  .meta({ name: "...", tags: ["api"] })
  .setup(async (ctx) => {
    return { token: "..." };         // State passed to steps
  })
  .step("step-name", async (ctx, state) => {
    // Use state from setup or previous step
    return { ...state, newData };     // Return new state (optional)
  })
  .teardown(async (ctx, state) => {
    // Always runs, even on failure — use for cleanup
  });
```

### test.each (one file = one case)

```typescript
const data = await fromDir<{ username: string }>("data/users/");

export const tests = test.each(data)(
  "user-$username",                   // $field interpolates from row
  async (ctx, row) => { ... },
);
```

### test.pick (named cases, merged files)

```typescript
const cases = await fromDir.merge<{ q: string }>("data/search/");

export const tests = test.pick(cases)(
  "search-$_pick",                    // $_pick = case name
  async (ctx, row) => { ... },
);
```

### test.extend (fixtures)

```typescript
import { test, type ExtensionFn } from "@glubean/sdk";

const pageFixture: ExtensionFn<Page> = async (ctx, use) => {
  const pg = await createPage();
  try { await use(pg); }
  finally { await pg.close(); }
};

const myTest = test.extend({ page: pageFixture });

export const t = myTest({ id: "..." }, async ({ page }) => {
  // page is available here
});
```

---

## TestContext

Every test function receives `ctx` with:

```typescript
ctx.http                              // Pre-configured HTTP client
ctx.expect(value)                     // Soft assertion (returns Expectation)
ctx.assert(condition, message?, details?)  // Hard assertion ({ actual, expected })
ctx.warn(condition, message)          // Warning (non-failing)
ctx.log(message, data?)              // Structured log
ctx.vars.require("KEY")              // Read env var (throws if missing)
ctx.secrets.require("KEY")           // Read secret (auto-redacted)
ctx.trace({ method, url, status, duration, ... })  // Record API trace
ctx.metric("name", value, { unit?, tags? })        // Record metric
ctx.validate(data, zodSchema, label?) // Schema validation
ctx.skip(reason?)                     // Skip test
ctx.fail(message)                     // Fail test immediately
ctx.pollUntil({ timeoutMs, intervalMs? }, fn)      // Poll until fn returns truthy
ctx.setTimeout(ms)                    // Override timeout
```

> **Not available in quick mode:** `setup()`, `step()`, `teardown()` are builder-mode-only APIs.
> If your test needs cleanup, use builder mode — see `patterns/crud.md`.

---

## HTTP Client

From `configure()` or `ctx.http`. Auto-traces requests.

```typescript
http.get(url, options?).json<T>()
http.post(url, options?).json<T>()
http.put(url, options?).json<T>()
http.patch(url, options?).json<T>()
http.delete(url, options?).json<T>()

// Also: .text(), .blob(), .arrayBuffer()
```

### Response typing

Prefer importing shared types over inline:

```typescript
// ✅ Shared type — reusable, stays in sync
import type { DirectionsResponse } from "../types/directions.ts";
const res = await api.get("directions/json").json<DirectionsResponse>();

// ❌ Inline type — duplicated across tests, drifts over time
const res = await api.get("directions/json")
  .json<{ status: string; routes: { geometry: string; distance: number }[] }>();
```

Check `types/` for existing types before creating inline ones.

### Options

```typescript
{
  json: { ... },                       // JSON body (auto-serialized)
  body: formData | string,             // Raw body
  searchParams: { key: "value" },      // Query string
  headers: { "X-Custom": "value" },    // Headers
  timeout: 5000,                       // ms (default 10000, false = no timeout)
  retry: 3,                            // Retry count (or { limit, statusCodes, methods })
  throwHttpErrors: false,               // Throw on 4xx/5xx (default false)
}
```

### Extend

```typescript
const authed = http.extend({
  headers: { Authorization: "Bearer ..." },
});
```

---

## Assertions — ctx.expect()

```typescript
// Equality
expect(x).toBe(y)
expect(x).toEqual(y)

// Truthiness
expect(x).toBeTruthy()
expect(x).toBeFalsy()
expect(x).toBeNull()
expect(x).toBeUndefined()
expect(x).toBeDefined()

// Numeric
expect(n).toBeGreaterThan(5)
expect(n).toBeGreaterThanOrEqual(5)
expect(n).toBeLessThan(10)
expect(n).toBeLessThanOrEqual(10)
expect(n).toBeWithin(1, 10)

// Strings & collections
expect(s).toContain("sub")
expect(s).toMatch(/regex/)
expect(s).toStartWith("pre")
expect(s).toEndWith("suf")
expect(arr).toHaveLength(3)

// Objects
expect(obj).toMatchObject({ key: "val" })
expect(obj).toHaveProperty("path.to.key", expectedValue?)
expect(obj).toHaveProperties(["a", "b"])

// HTTP responses
expect(res).toHaveStatus(200)
await expect(res).toHaveJsonBody({ key: "val" })
expect(res).toHaveHeader("content-type", /json/)

// Modifiers
expect(x).not.toBe(y)                // Negate
expect(x).toBe(y).orFail()           // Hard fail (stop test)

// Custom
expect(x).toSatisfy(v => v > 0)
expect(x).toBeType("string")
```

---

## configure()

File-level setup. Binds env vars, creates HTTP client, registers plugins.

```typescript
const { http, vars, secrets } = configure({
  vars: { user: "{{GITHUB_USER}}" },    // {{KEY}} → resolved from .env
  secrets: { token: "{{API_KEY}}" },   // {{KEY}} → resolved from .env.secrets
  http: {
    prefixUrl: "{{BASE_URL}}",         // {{KEY}} → resolved at runtime
    headers: {
      Authorization: "Bearer {{API_KEY}}",  // {{var}} interpolation
      Accept: "application/json",
    },
    timeout: 15000,
    retry: 2,
  },
});

// vars.user → reads process.env.GITHUB_USER
// secrets.token → reads from .env.secrets
// http → pre-configured client with base URL + auth headers
```

### With plugins

```typescript
const { http, chrome } = configure({
  http: { prefixUrl: "{{BASE_URL}}" },
  plugins: {
    chrome: browser({ launch: true, launchOptions: { headless: true } }),
  },
});
```

### definePlugin()

```typescript
const myPlugin = definePlugin((runtime) => {
  const apiKey = runtime.requireSecret("MY_KEY");
  return {
    doSomething: () => { ... },
  };
});

const { myPlugin: instance } = configure({
  plugins: { myPlugin },
});
```

---

## Data Loading

```typescript
// Directory: one JSON/YAML file = one row
const rows = await fromDir<T>("data/users/");
// Returns: [{ username: "alice", _name: "alice", _path: "data/users/alice.json" }, ...]

// Directory: merge shared + *.local.json overrides
const cases = await fromDir.merge<T>("data/search/");
// Returns: { "case-name": { q: "test", min: 5 }, ... }

// Directory: concatenate arrays from files
const items = await fromDir.concat<T>("data/items/");

// CSV
const rows = await fromCsv<T>("data/file.csv");
const rows = await fromCsv<T>("data/file.tsv", { separator: "\t" });
const rows = await fromCsv<T>("data/file.csv", { headers: false }); // numeric keys

// YAML
const rows = await fromYaml<T>("data/file.yaml");
const rows = await fromYaml<T>("data/nested.yaml", { pick: "data.testCases" }); // dot-path to array

// JSONL (one JSON object per line)
const rows = await fromJsonl<T>("data/file.jsonl");
```

### Data file conventions

- `data/` directory at project root
- Prefer bare `data/...` paths for shared project data
- `shared.json` for committed defaults
- `*.local.json` for personal overrides (gitignored)
- Each JSON or YAML file in `fromDir()` becomes one test case; filename = case name (default extensions: `.json`, `.yaml`, `.yml`)

---

## defineSession()

Define session setup/teardown for cross-file state sharing. Place in `session.ts` at your test root — the runner auto-discovers it.

```typescript
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup(ctx) {
    const { access_token } = await ctx.http
      .post("/auth/login", {
        json: { user: ctx.vars.require("USER"), pass: ctx.secrets.require("PASS") },
      })
      .json<{ access_token: string }>();
    ctx.session.set("token", access_token);
  },
  async teardown(ctx) {
    await ctx.http.post("/auth/logout", {
      headers: { Authorization: `Bearer ${ctx.session.get("token")}` },
    });
  },
});
```

In tests, read session values with `ctx.session.require("key")` or `ctx.session.get("key")`.

---

## Browser Plugin (@glubean/browser)

### Setup

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
      baseUrl: "{{APP_URL}}",           // {{KEY}} → resolved from .env
      screenshot: "on-failure",        // "off" | "on-failure" | "every-step"
      networkTrace: true,              // Auto-capture HTTP traces
    }),
  },
});

export const browserTest = test.extend({
  page: async (ctx, use) => {
    const pg = await chrome.newPage(ctx);
    try { await use(pg); }
    finally { await pg.close(); }
  },
});
```

### Page API

```typescript
// Navigation
await page.goto("https://example.com");
await page.goto("/relative");          // Uses baseUrl

// Interaction
await page.click("#button");
await page.clickAndNavigate("#link");   // Click + wait for navigation
await page.type("#input", "text");
await page.fill("#input", "value");     // Clear + type
await page.select("#dropdown", "option-value");
await page.hover("#element");
await page.press("Enter");
await page.upload("#file-input", "./path/to/file");

// Assertions (soft-fail, auto-waiting with timeout)
await page.expectText("#msg", "Welcome");
await page.expectText("#msg", /pattern/);
await page.expectURL("/dashboard");
await page.expectVisible(".success");
await page.expectHidden(".loading");

// DOM queries
const text = await page.textContent("#el");
const html = await page.innerHTML("#el");
const value = await page.inputValue("#input");
const visible = await page.isVisible("#el");

// Evaluate JS in browser
const count = await page.evaluate(() => document.querySelectorAll("li").length);

// Screenshots
await page.screenshot();               // Auto-saved as artifact

// Wait
await page.waitForURL("/target");

// Locator (auto-waiting)
await page.locator("#btn").click();
await page.locator("#input").fill("text");
```

---

## CLI Commands

```bash
glubean run                            # Run all tests
glubean run tests/api/                 # Run specific directory
glubean run tests/api/health.test.ts   # Run single file
glubean run --filter smoke             # Filter by tag
glubean run --upload                   # Upload results to Cloud
glubean run --upload --tag ci          # Tag the run
```

---

## Project Structure Convention

```
config/              # Shared HTTP clients, browser fixtures, plugin configs
  api.ts             # configure() for API under test
  browser.ts         # browser plugin + browserTest fixture
tests/
  api/               # API integration tests
  e2e/               # Browser end-to-end tests
data/                # Test data files (JSON, CSV, YAML)
.env                 # Public variables (BASE_URL, APP_URL)
.env.secrets         # Credentials (API_KEY) — gitignored
package.json         # Runtime config, npm deps, glubean settings
AGENTS.md            # AI agent instructions
```
