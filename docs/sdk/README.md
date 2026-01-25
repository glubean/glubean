## Glubean SDK Design and Roadmap

This document describes the SDK design goals, the near/mid/long-term roadmap, and
the proposed API surface with **example usage**, **why it exists**, and **how it works**.

### Blueprint alignment

- **Contracts-first**: SDK stays thin and stable; runners and UI consume a shared event schema.
- **Reproducibility**: tests use `ctx.vars` (and later `ctx.secrets`) as the only config path.
- **Outbound-only**: no SDK dependency on control-plane APIs.
- **Secrets safety**: secrets are never logged in plaintext; SDK helpers must enforce redaction.

---

## Current SDK (v2.0)

### What exists today

**New unified API (recommended)**:

- `test(id, fn)` - Quick mode for simple tests
- `test(id).step().build()` - Builder mode for multi-step tests
- Global registry for metadata extraction (enables runtime scanning)

**Legacy API (backward compatible)**:

- `testCase(meta, fn)` and `testSuite(meta, config)` helpers

**TestContext** with:

- `vars.get(key)` / `vars.require(key)` / `vars.all()` - Safe variable access
- `secrets` - Secure access to secrets
- `log(message, data?)` - Structured logging
- `assert(...)` - Boolean or structured assertions
- `trace(request)` - Manual API tracing

### What is missing

- Structured HTTP tracing helpers (`ctx.fetch`).
- Run-time fail/skip helpers.
- Event schema shared across runner/control-plane/UI.

---

## Roadmap (phased)

### Phase 1 / 1.5 (Core: observability + reproducibility)

Goal: Make AI-generated tests **default-correct** and **observable**, without becoming a full framework.

**Planned APIs**

1. `ctx.vars.get(key)` / `ctx.vars.require(key)`
2. `ctx.step(name, fn)`
3. `ctx.fetch(url, init?)`
4. `ctx.fail(message)`
5. `ctx.skip(reason?)`
6. `ctx.pollUntil(options, fn)`

### Phase 2 (Operational reliability + signal quality)

Goal: Reduce flakiness noise and enable richer evidence.

**Planned APIs**

1. `ctx.expect(...)` matchers (small set, not a full framework)
2. `ctx.artifact.*` (text/json/blob attachments)
3. `ctx.metric(name, value, tags?)`
4. Runner/policy-driven retries (not an SDK `retry` helper)

### Phase 3+ (Enterprise + ecosystem)

Goal: Private runner and enterprise workflows.

**Planned APIs**

1. Plugin/reporters interface
2. Secrets handles (non-string printable)
3. Cross-language SDK compatibility (Node/Python)

---

## Event Schema (Required Before Expanding APIs)

All new SDK APIs must emit events defined in **one shared contract**.
This prevents divergence between runner, server, and UI.

**Required action before Phase 1 SDK expansion**:

- Move `ExecutionEvent` to a shared contracts module.
- Document event types and payload fields in one place.
- Update runner/harness and server UI to consume the shared schema.

---

## API Design (Short-term)

Below are the APIs proposed for Phase 1/1.5.

Each API includes:

- **Example usage**
- **Why it exists**
- **How it works**

---

### 1) `ctx.vars.get(key)` / `ctx.vars.require(key)`

**Example usage**

```ts
const baseUrl = ctx.vars.require("BASE_URL");
const apiKey = ctx.vars.get("API_KEY");
```

**Why**

- Missing env vars currently produce `undefined` and silent failures.
- AI-generated code often forgets to validate config.

**How**

- `get` returns `string | undefined`.
- `require` throws a clear error if missing:
  - "Missing required var: BASE_URL"
- These errors become explicit failure messages for runs.

---

### 2) `ctx.step(name, fn)`

**Example usage**

```ts
await ctx.step("login", async () => {
  const res = await ctx.fetch(`${ctx.vars.require("BASE_URL")}/login`, {
    method: "POST",
    body: JSON.stringify({ user: "demo", pass: "demo" }),
  });
  ctx.assert(res.ok, "login succeeded");
});
```

**Why**

- Flat logs are hard to read in live tail.
- Steps improve UX and make failures more diagnosable.

**How**

- Emits `step_start` and `step_end` events.
- If the step throws, emits `step_end` with `status=failed` and rethrows.

---

### 3) `ctx.fetch(url, init?)`

**Example usage**

```ts
const res = await ctx.fetch(`${ctx.vars.require("BASE_URL")}/health`);
ctx.assert(res.ok, "health ok");
```

**Why**

- Manual `ctx.trace(...)` is easy to forget.
- Most tests are HTTP-based; tracing should be automatic.

**How**

- Wraps `fetch`.
- Measures duration and emits a `trace` event with:
  - method, url, status, duration
  - optionally headers/body (redacted/truncated)
- Does **not** log secrets by default.

---

### 4) `ctx.fail(message)`

**Example usage**

```ts
if (!featureEnabled) {
  ctx.fail("Feature X is disabled in this environment");
}
```

**Why**

- `throw` is semantically vague; `assert(false)` is noisy.
- A dedicated failure API improves diagnostics.

**How**

- Throws a controlled error type internally.
- Runner translates it into a `status: failed` event with message.

---

### 5) `ctx.skip(reason?)`

**Example usage**

```ts
if (ctx.vars.get("SKIP_SMOKE") === "true") {
  ctx.skip("Smoke tests disabled for this environment");
}
```

**Why**

- Teams need runtime conditional tests (not only static meta.skip).

**How**

- Emits `status: skipped` and stops the test early.
- UI should show skip reason in run detail.

---

### 6) `ctx.pollUntil({ timeoutMs, intervalMs }, fn)`

**Example usage**

```ts
await ctx.pollUntil({ timeoutMs: 30_000, intervalMs: 1_000 }, async () => {
  const res = await ctx.fetch(`${ctx.vars.require("BASE_URL")}/ready`);
  return res.ok;
});
```

**Why**

- Many systems are eventually consistent; polling is common.
- This improves stability without pushing retry policy into user code.

**How**

- Repeats `fn` until it returns truthy or timeout.
- Emits structured log events for each attempt.
- Throws an explicit timeout error if exceeded.

---

## Medium-term APIs (Phase 2)

### `ctx.expect(...)` (limited matchers)

**Example usage**

```ts
ctx.expect(res.status).toEqual(200);
ctx.expect(body).toContain("success");
```

**Why**

- More expressive assertions improve readability.

**How**

- Implement 5–10 high-signal matchers only.
- Avoid full Jest-like matcher explosion.

---

### `ctx.artifact.*` (attachments)

**Example usage**

```ts
ctx.artifact.text("response-body", await res.text());
ctx.artifact.json("profile", data);
```

**Why**

- Failures often require evidence.

**How**

- Emit `artifact` events with size limits.
- Later map to object storage.

---

### `ctx.metric(name, value, tags?)`

**Example usage**

```ts
ctx.metric("checkout.latency_ms", duration, { region: "us-west" });
```

**Why**

- Enables trend analysis and SLO-style alerts.

**How**

- Emit `metric` events; server aggregates.

---

## Long-term APIs (Phase 3+)

### Secrets handles (non-string)

**Example usage**

```ts
const token = ctx.secrets.get("API_TOKEN");
await ctx.fetch(`${baseUrl}/private`, {
  headers: { Authorization: `Bearer ${token.value}` },
});
```

**Why**

- Prevent accidental logging or stringification of secrets.

**How**

- Return an opaque type that redacts by default.

---

### Plugin/reporters

**Example usage**

```ts
export const reporter = defineReporter({
  onEvent(event) {
    /* custom handling */
  },
});
```

**Why**

- Extensibility for enterprise workflows and integrations.

**How**

- Pluggable hooks with strict event schema.

---

## Suggested DoD for Phase 1 SDK

- A new user can write a test using `ctx.step`, `ctx.fetch`, and `ctx.vars.require`.
- Missing vars produce an explicit error.
- Live tail shows structured steps (start/end).
- All events conform to one shared schema.

---

## Example: Full Test Using New API

### Quick mode (simple tests)

```ts
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const baseUrl = ctx.vars.require("BASE_URL");
  const res = await fetch(`${baseUrl}/health`);
  ctx.assert(res.ok, "health check passed");
});
```

### Builder mode (multi-step tests)

```ts
import { test } from "@glubean/sdk";

export const loginFlow = test("login-flow")
  .meta({ tags: ["auth", "smoke"] })
  .setup(async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    return { baseUrl };
  })
  .step("Login", async (ctx, { baseUrl }) => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      body: JSON.stringify({ user: "demo", pass: "demo" }),
    });
    ctx.assert(res.ok, "login succeeded");
    const { token } = await res.json();
    return { baseUrl, token };
  })
  .step("Verify session", async (ctx, { baseUrl, token }) => {
    const res = await fetch(`${baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ctx.assert(res.ok, "session valid");
  })
  .build();
```

### Legacy API (backward compatible)

```ts
import { testCase } from "@glubean/sdk";

export const login = testCase("login", async (ctx) => {
  const baseUrl = ctx.vars.require("BASE_URL");
  const res = await fetch(`${baseUrl}/login`, {
    method: "POST",
    body: JSON.stringify({ user: "demo", pass: "demo" }),
  });
  ctx.assert(res.ok, "login ok");
});
```
