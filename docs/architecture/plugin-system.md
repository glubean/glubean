# Plugin Architecture

> Status: **Design** — This document describes the target architecture for Glubean's plugin system. No code changes have
> been made yet.

## Motivation

Glubean's SDK currently bundles protocol-specific features (GraphQL) and has no formal extension points for community
packages. As the surface area grows (auth, gRPC, WebSocket, database assertions, custom reporters), every new capability
requires changes to the core SDK. This doesn't scale.

The goal is to make the SDK **small, stable, and extensible** — like Rollup's core is just a bundler, but the plugin
ecosystem handles everything else.

### Why Now

- The SDK hasn't shipped to production users yet. This is the cheapest possible moment to get the architecture right —
  no migration burden, no deprecation windows, no backward compatibility constraints.
- The GraphQL client is the only protocol-specific module in the SDK. Extracting it now sets the precedent that protocol
  clients are plugins.
- Users are asking for auth support. Building it as a plugin from day one validates the architecture with a real use
  case.
- The SDK's type system already supports most of the patterns needed (lazy proxy in `configure()`, builder generics in
  `TestBuilder`). The gap is API surface, not infrastructure.

### Design Principles

1. **Plugins are just functions.** No registry, no lifecycle framework, no magic. A plugin is a JSR/npm package that
   exports functions compatible with existing SDK extension points.

2. **The module system is the plugin system.** `deno add @glubean/auth` and import. That's it.

3. **Type safety is free.** TypeScript generics infer plugin types at the call site. No `declare module` boilerplate for
   the common case.

4. **Composition over configuration.** Plugins compose via function composition, not configuration files.

5. **No harness changes for Phase 1.** All initial plugin hooks operate at the SDK layer. The runner/harness doesn't
   need to know about plugins.

---

## The Pipeline

Glubean's test execution has six stages, plus a Cloud-side visualization layer. Each stage maps to a plugin hook:

```
┌──────────┐   ┌───────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
│ discover │ → │ configure │ → │ context  │ → │  execute  │ → │  assert  │ → │  report  │   │ visualize │
└──────────┘   └───────────┘   └──────────┘   └───────────┘   └──────────┘   └──────────┘   └───────────┘
    Hook 1         Hook 2         Hook 3          Hook 4         Hook 5         Hook 6         Cloud-side
```

| Hook | Stage     | Extension Point                                | Example Plugins                               |
| ---- | --------- | ---------------------------------------------- | --------------------------------------------- |
| 1    | Discover  | Data loaders for `test.each()`                 | Excel, Notion, Postman collection             |
| 2    | Configure | `configure({ plugins })`                       | GraphQL, gRPC, WebSocket clients              |
| 3    | Context   | `test.extend()`                                | Database fixtures, auth state on ctx          |
| 4    | Execute   | HTTP hooks (`beforeRequest` / `afterResponse`) | OAuth token injection, request signing, retry |
| 5    | Assert    | `Expectation.extend()`                         | OpenAPI validation, JSON Schema matchers      |
| 6    | Report    | `onEvent` callback (already exists)            | Slack, Datadog, GitHub PR comments            |
| —    | Visualize | `RenderHint` on `RunEvent` (Cloud viewer)      | GraphQL query card, DB fixture summary        |

Hooks 1–6 run in the SDK/runner (OSS). The visualize layer runs in Cloud only and is described in
[Plugin Event Visualization](#plugin-event-visualization-cloud).

---

## Hook 1: Data Loaders (Discover)

**Status:** Already open — no SDK changes needed.

Any function that returns `T[]` or `Promise<T[]>` works with `test.each()`. The SDK re-exports built-in loaders
(`fromCsv`, `fromYaml`, `fromJsonl`, `fromDir`) as conveniences, but they have no special status.

```typescript
// Community plugin — zero SDK changes needed
import { fromExcel } from "@acme/glubean-data-excel";

export const tests = test.each(await fromExcel("./data/cases.xlsx"))(
  "case-$id",
  async (ctx, row) => { ... },
);
```

**Action:** Documentation only. Publicize that `test.each()` accepts any `T[]`.

---

## Hook 2: Configure Plugins

**Status:** Requires SDK changes (~50 lines).

### New Types

```typescript
// packages/sdk/types.ts

/**
 * A plugin factory that creates a lazy instance of type T.
 * Used with `configure({ plugins: { key: factory } })`.
 * Plugin authors should use `definePlugin()` instead of implementing directly.
 */
export interface PluginFactory<T> {
  /** Phantom field for TypeScript inference. Not used at runtime. */
  readonly __type: T;
  /** Called lazily on first access during test execution. */
  create(runtime: GlubeanRuntime): T;
}

/**
 * Runtime context available to plugin factories.
 * Exposes the same capabilities the harness provides to configure().
 *
 * Stability: fields may be added (minor), but existing field semantics
 * must not change without a major version bump. This is the contract
 * between the SDK and all plugins.
 */
export interface GlubeanRuntime {
  /** Resolved vars with env fallback */
  vars: Record<string, string>;
  /** Resolved secrets with env fallback */
  secrets: Record<string, string>;
  /** Pre-configured HTTP client with auto-tracing */
  http: HttpClient;
  /** Require a var (throws if missing) */
  requireVar(key: string): string;
  /** Require a secret (throws if missing) */
  requireSecret(key: string): string;
  /** Resolve {{key}} template placeholders */
  resolveTemplate(template: string): string;
}
```

### `definePlugin()` Helper

Plugin authors should never need to understand the `PluginFactory` phantom field trick. The SDK provides a helper that
handles it:

```typescript
// packages/sdk/plugin.ts

/**
 * Create a plugin factory. This is the recommended way to define plugins.
 *
 * @example
 * export const myPlugin = (opts: MyOptions) =>
 *   definePlugin((runtime) => new MyClient(runtime, opts));
 */
export function definePlugin<T>(
  create: (runtime: GlubeanRuntime) => T,
): PluginFactory<T> {
  return { __type: undefined as unknown as T, create };
}
```

This is ~5 lines in the SDK but eliminates the `__type` confusion for every plugin author. All first-party plugins
(`@glubean/graphql`, `@glubean/auth`) use `definePlugin()` in their implementation.

### `configure()` Signature

```typescript
function configure<
  V,
  S,
  P extends Record<string, PluginFactory<unknown>> = {},
>(options: {
  vars?: V;
  secrets?: S;
  http?: ConfigureHttpOptions;
  plugins?: P;
}): { vars; secrets; http } & ResolvePlugins<P>;

// Type helper — maps plugin factories to their resolved types
type ResolvePlugins<P> = {
  [K in keyof P]: P[K] extends PluginFactory<infer T> ? T : never;
};
```

The old `graphql` option is removed entirely (not deprecated — the SDK hasn't shipped yet). GraphQL is now a plugin like
any other.

### Implementation

`buildLazyPlugins()` follows the same lazy proxy pattern as `buildLazyVars()` and `buildLazyHttp()`: a `WeakMap` cache
keyed on the runtime identity, with `Object.defineProperty` getters that resolve on first access.

### Usage

```typescript
import { configure } from "@glubean/sdk";
import { graphql } from "@glubean/graphql";

const { http, graphql: gql } = configure({
  http: { prefixUrl: "base_url" },
  plugins: {
    graphql: graphql({
      endpoint: "graphql_url",
      headers: { Authorization: "Bearer {{api_key}}" },
    }),
  },
});

// TypeScript infers: gql is GraphQLClient — full autocomplete
```

---

## Hook 3: Context Extension (`test.extend`)

**Status:** Requires SDK changes (~120 lines code + ~20 type signature updates).

Inspired by Playwright's `test.extend()`. Creates a new `test` function where the context type is augmented with
plugin-provided properties.

### API

```typescript
// tests/fixtures.ts
import { test as base } from "@glubean/sdk";
import { createAuth } from "@glubean/auth";
import { createDb } from "@glubean/db";

export const test = base.extend({
  // Simple: factory returns instance
  auth: (ctx) => createAuth(ctx, { ... }),

  // Lifecycle: setup + teardown via `use` callback
  db: async (ctx, use) => {
    const db = await connect(ctx.vars.require("DB_URL"));
    await use(db);         // test runs here
    await db.disconnect();  // cleanup after test
  },
});

// tests/users.test.ts
import { test } from "./fixtures.ts";

export const myTest = test("my-test", async (ctx) => {
  ctx.auth.bearer(token);    // full autocomplete
  ctx.db.query("SELECT 1");  // full autocomplete
});
```

### Chained Extend

`test.extend()` returns a new test function that itself has `.extend()`, enabling layered fixtures (same pattern as
Playwright):

```typescript
// tests/fixtures/auth.ts
import { test as base } from "@glubean/sdk";
export const test = base.extend({
  auth: (ctx) => createAuth(ctx, { ... }),
});

// tests/fixtures/db.ts
import { test as withAuth } from "./auth.ts";
export const test = withAuth.extend({
  db: async (ctx, use) => {
    const db = await connect(ctx.vars.require("DB_URL"));
    await use(db);
    await db.disconnect();
  },
});

// tests/users.test.ts — has both auth and db
import { test } from "./fixtures/db.ts";
```

This avoids the anti-pattern of one massive `.extend()` call with all fixtures declared in a single file.

### Type Inference

```typescript
type ExtensionFn<T> =
  | ((ctx: TestContext) => T)
  | ((ctx: TestContext, use: (instance: T) => Promise<void>) => Promise<void>);

type ResolveExtensions<E> = {
  [K in keyof E]: E[K] extends ExtensionFn<infer T> ? T : never;
};
```

When a user writes `base.extend({ auth: fn, db: fn })`, TypeScript infers the return types and produces
`TestContext & { auth: AuthClient; db: DbClient }`. Chained extends accumulate: `withAuth.extend({ db })` produces
`TestContext & { auth: AuthClient } & { db: DbClient }`.

### Builder Support

`TestBuilder` has a second type parameter for the context type:

```typescript
class TestBuilder<S = unknown, Ctx extends TestContext = TestContext> {
  step(
    name: string,
    fn: (ctx: Ctx, state: S) => Promise<void>,
  ): TestBuilder<S, Ctx>;
}
```

`Ctx` defaults to `TestContext`, so `test("name").step(...)` works without any generic annotations. When using an
extended test, `Ctx` is inferred automatically from the extensions.

---

## Hook 4: HTTP Middleware

**Status:** Requires ~5 lines of SDK changes.

The `HttpHooks` interface already exists in `types.ts`, and `HttpRequestOptions` already supports hooks. The only gap:
`ConfigureHttpOptions` doesn't expose hooks.

### Change

```typescript
// packages/sdk/types.ts — add one field
export interface ConfigureHttpOptions {
  prefixUrl?: string;
  headers?: Record<string, string>;
  timeout?: number | false;
  retry?: number | HttpRetryOptions;
  throwHttpErrors?: boolean;
  hooks?: HttpHooks; // ← NEW
}
```

```typescript
// packages/sdk/configure.ts — pass hooks through to ky
// In buildLazyHttp(), add:
if (httpOptions.hooks) {
  extendOptions.hooks = httpOptions.hooks;
}
```

### Usage

```typescript
import { oauth2 } from "@glubean/auth";

const { http } = configure({
  http: oauth2.clientCredentials({
    prefixUrl: "base_url",
    tokenUrl: "token_url",
    clientId: "client_id",
    clientSecret: "client_secret",
  }),
  // oauth2.clientCredentials() returns ConfigureHttpOptions with hooks
});
```

---

## Hook 5: Custom Assertion Matchers

**Status:** Requires ~30 lines of SDK changes.

### Current State

`Expectation` uses TypeScript `private` (not `#private`), so prototype extension works at runtime today. But there's no
official API for it.

### API

```typescript
// packages/sdk/expect.ts — new types and static method

interface MatcherResult {
  passed: boolean;
  message: string;
  actual?: unknown;
  expected?: unknown;
}

type MatcherFn = (actual: unknown, ...args: unknown[]) => MatcherResult;

class Expectation<T> {
  // ... existing methods ...

  /**
   * Register custom matchers on the Expectation prototype.
   * Matchers are pure functions: receive actual + args, return result.
   * The SDK handles .not negation and .orFail() chaining automatically.
   */
  static extend(matchers: Record<string, MatcherFn>): void;
}
```

### Isolation Guarantee

A common concern with prototype mutation: can `Expectation.extend()` in one test file leak matchers into another? In
Glubean's runner, **no** — each test file runs in its own Deno subprocess. Prototype mutations in file A cannot affect
file B. This is a stronger guarantee than Jest/Vitest (which share a process). Call `Expectation.extend()` once at file
scope (import side effect) and it's scoped to that subprocess.

### Plugin Author Experience

```typescript
// @glubean/expect-openapi
import { Expectation } from "@glubean/sdk/expect";

Expectation.extend({
  toMatchOpenAPI(actual, spec, operationId) {
    const passed = validateAgainstSpec(actual, spec, operationId);
    return {
      passed,
      message: `to match OpenAPI spec for "${operationId}"`,
      actual,
      expected: operationId,
    };
  },
});

// Type augmentation (same pattern as Jest)
declare module "@glubean/sdk/expect" {
  interface Expectation<T> {
    toMatchOpenAPI(spec: unknown, operationId: string): this;
  }
}
```

---

## Hook 6: Event Reporters (Report)

**Status:** Already open — no SDK changes needed.

The executor's `onEvent: (event: TimelineEvent) => void` callback is the hook. Any package can export a reporter:

```typescript
// @glubean/reporter-slack
export function createSlackReporter(options: { webhook: string }) {
  const events: TimelineEvent[] = [];
  return {
    handler: (event: TimelineEvent) => events.push(event),
    flush: async () => {
      /* POST summary to Slack webhook */
    },
  };
}
```

**Action:** Documentation only.

---

## Plugin Event Visualization (Cloud)

> **Priority:** Post-cloud-launch. This section is not required for Phase 1–4 (SDK-side plugin architecture), but **must
> be addressed before plugins ship events that users expect to see in the Cloud dashboard**.

### The Gap

Hooks 1–6 cover the full **execution** pipeline: plugins can load data, configure clients, extend context, intercept
HTTP, define custom assertions, and report events. But when a plugin produces a new event type (e.g.
`plugin:graphql:query` or `plugin:db:fixture-setup`), the Cloud viewer has no mechanism to render it. Today's
`RunEvent.type` in `@glubean/contracts` is a closed union — the viewer only knows how to render `log`, `assert`,
`trace`, `metric`, etc.

The storage layer (`RunEventEntity` in MongoDB) already stores `type: string` and `payload: unknown`, so plugin events
can be persisted. The gap is between **ingestion** and **presentation**: no schema contract, no rendering protocol, no
fallback UX.

### Why This Is Hard

Three tensions make this a non-trivial design problem:

1. **Open vs. secure.** Plugins want expressive visualization, but the Cloud viewer must never execute third-party
   frontend code (XSS, supply chain).
2. **Decoupled vs. consistent.** Plugins iterate faster than the Cloud frontend deploys. Rendering can't require a Cloud
   redeploy per plugin.
3. **Rich vs. portable.** Plugin authors want tables, diffs, and code blocks — but the rendering vocabulary must remain
   finite and controlled by core.

### Shared Foundation

Regardless of which rendering approach is used, the following changes are required as a foundation.

#### Open `RunEvent.type` namespace

```typescript
// @glubean/contracts — backward-compatible extension
export interface RunEvent {
  runId: Id;
  taskId: Id;
  seq: number;
  ts: IsoDateTime;
  type: KnownEventType | `plugin:${string}`;
  redacted?: boolean;
  payload: unknown;
  /** Optional rendering hint for Cloud viewer. */
  render?: RenderHint;
}

type KnownEventType =
  | "log"
  | "assert"
  | "trace"
  | "metric"
  | "result"
  | "system"
  | "step_start"
  | "step_end"
  | "summary";
```

Existing `KnownEventType` values are unchanged. Plugin events use the `plugin:` prefix namespace (e.g.
`plugin:graphql:query`, `plugin:auth:token-refresh`).

#### SDK emit API

Plugins produce custom events via a `ctx.emit()` helper:

```typescript
ctx.emit("plugin:graphql:query", {
  payload: { query, variables, response, durationMs },
  render: { kind: "code", language: "graphql" },
});
```

#### Viewer fallback pyramid

No matter which rendering solution is chosen, the Cloud viewer uses a fallback chain so that **no plugin event is ever
invisible**:

1. **Dedicated renderer** — if a purpose-built component exists for this event type, use it.
2. **RenderHint renderer** — if the event carries a `render` field, use the matching built-in renderer (kv, table, code,
   etc.).
3. **Structured fallback** — display a "Plugin Event" card with the type name and a collapsible JSON tree of the
   payload.
4. **Raw fallback** — collapsed raw JSON for completely unknown events.

#### Security invariants

- **Redaction still applies.** Plugin event payloads pass through the same ingestion-time redaction pipeline as all
  other events (Blueprint invariant E).
- **Markdown is sanitized.** The `markdown` render hint goes through a safe markdown renderer (no raw HTML
  pass-through).

---

### Solution Candidate A: Structured Render Hints (recommended starting point)

Plugins don't ship frontend code. They ship **structured rendering hints** alongside their events. The Cloud viewer has
a finite set of built-in renderers that interpret these hints. No third-party JS ever reaches the browser.

**`RenderHint` vocabulary:**

```typescript
type RenderHint =
  | { kind: "kv"; label: string }
  | { kind: "table"; columns: string[] }
  | { kind: "timeline" }
  | { kind: "code"; language?: string }
  | { kind: "diff"; before?: string; after?: string }
  | { kind: "badge"; variant: "success" | "warning" | "error" | "info" }
  | { kind: "markdown"; content: string }
  | { kind: "hidden" };
```

New `RenderHint.kind` values are added via core viewer releases, not by plugins. This keeps the rendering vocabulary
bounded and quality-controlled.

**Usage:**

```typescript
ctx.emit("plugin:graphql:query", {
  payload: { query, variables, response, durationMs },
  render: { kind: "code", language: "graphql" },
});

ctx.emit("plugin:db:fixtures", {
  payload: { table: "users", rows: 5, durationMs: 120 },
  render: { kind: "kv", label: "Database Fixture" },
});
```

**Strengths:**

- Zero friction for plugin authors — attach a hint, get rendering
- No security surface — viewer controls all rendering code
- Visual consistency guaranteed by design
- Works immediately for the fallback pyramid (layers 2–4)

**Limitations:**

- Expressiveness is bounded by the hint vocabulary
- Complex visualizations (flame graphs, multi-panel layouts) can't be represented
- Adding new hint kinds requires a core viewer release

**When to use:** Default for all plugins. Covers 90%+ of real use cases (tables, code blocks, key-value cards, diffs,
badges, timelines).

---

### Solution Candidate B: Community Renderer Repo (for richer visualization)

An open-source `glubean/plugin-renderers` repo where plugin authors submit full React components as pull requests. The
Glubean team reviews, merges, and the Cloud viewer imports the registry as a dependency.

**Repo structure:**

```
glubean/plugin-renderers
├── renderers/
│   ├── graphql/
│   │   ├── QueryCard.tsx          # Full React component
│   │   ├── QueryCard.stories.tsx  # Storybook visual tests
│   │   └── index.ts
│   ├── auth/
│   │   ├── TokenFlow.tsx
│   │   └── index.ts
│   └── db/
│       ├── FixtureTable.tsx
│       └── index.ts
├── shared/                        # Design system primitives for renderers
│   ├── Card.tsx
│   ├── CodeBlock.tsx
│   ├── Badge.tsx
│   └── index.ts
├── registry.ts                    # Maps "plugin:*" types → components
├── CONTRIBUTING.md
└── AGENTS.md                      # AI review guidelines
```

**Cloud viewer integration:**

```typescript
import { getRenderer } from "@glubean/plugin-renderers";

const Renderer = getRenderer(event.type);
if (Renderer) {
  return <Renderer event={event} theme={theme} />;
}
// fall through to RenderHint → structured fallback → raw JSON
```

**Review model:** Plugin authors submit PRs with a React component, Storybook stories, and tests. AI-assisted code
review (with clear rules in `CONTRIBUTING.md` and `AGENTS.md`) handles most verification — correct use of `shared/`
components, dark mode support, no external network calls, no DOM manipulation outside the component tree. Human review
becomes a quick final approval.

**Strengths:**

- Full React expressiveness — flame graphs, interactive panels, rich layouts are all possible
- Native look and feel — renderers use the same design system as the viewer
- Community-driven — plugin authors own their visualization
- Security by review — no untrusted code reaches production without approval
- AI-assisted review scales well — the review surface is small and well-defined (React component with constrained
  imports)

**Limitations:**

- Requires the `plugin-renderers` repo infrastructure (Storybook, CI, shared component library)
- Renderer availability lags behind plugin releases (PR → review → merge → deploy). RenderHint fallback covers the gap.
- Design system changes in the viewer may require renderer updates (mitigated by stable `shared/` exports)

**When to use:** First-party plugins and popular community plugins that need visualization beyond what RenderHint can
express. Not required for simple plugins.

---

### Recommendation

Start with **Candidate A** (RenderHint) — it's the simplest path, covers most use cases, and works from day one as the
fallback layer. Evaluate **Candidate B** (plugin-renderers repo) once Cloud is live and first-party plugins
(`@glubean/graphql`, `@glubean/auth`) need richer dashboard cards. The two approaches are complementary, not mutually
exclusive — Candidate B adds a layer above Candidate A in the fallback pyramid.

---

## Target SDK Structure (Post-Plugin)

### Core Kernel (`@glubean/sdk`)

Only what cannot be extracted:

```
@glubean/sdk
├── mod.ts          # test(), test.extend(), test.each(), test.pick()
│                   # TestBuilder<S, Ctx>, EachBuilder<S, T, Ctx>
├── types.ts        # TestContext, HttpClient, HttpHooks
│                   # PluginFactory<T>, GlubeanRuntime
├── plugin.ts       # definePlugin() helper
├── configure.ts    # configure() with plugins slot
│                   # buildLazyPlugins(), public resolveTemplate()
├── expect.ts       # Expectation with extend() support
├── data.ts         # Built-in loaders (fromCsv, fromYaml, fromJsonl, fromDir)
└── internal.ts     # Test registry
```

### Extracted Plugins

```
@glubean/graphql    # GraphQL client (extracted from core)
@glubean/auth       # Bearer, Basic, API Key, OAuth 2.0
```

### Community Ecosystem (future)

```
@glubean/grpc           # gRPC client
@glubean/websocket      # WebSocket testing
@glubean/db             # Database fixtures
@glubean/mock           # Mock server (MSW-like)
@glubean/expect-openapi # OpenAPI assertion matchers
@glubean/reporter-slack # Slack notifications
...
```

---

## Implementation Plan

### Phase 0: Prerequisites (1-2 days)

Before extracting GraphQL, establish behavioral baselines so the plugin version can be verified against the original.

| Task                                               | Files                     | Why                                                                                    |
| -------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Write behavioral tests for GraphQL client          | sdk/graphql_test.ts       | No existing tests — extraction without baseline risks silent regression                |
| Write behavioral tests for `fromGql()` data loader | sdk/data_test.ts (extend) | `fromGql` moves with GraphQL; must verify before/after equivalence                     |
| Audit full GraphQL surface in SDK                  | —                         | Document every touch point (see [GraphQL Extraction Scope](#graphql-extraction-scope)) |

**Exit criteria:** All new GraphQL tests green. Touch point audit complete.

**Outcome:** Confidence that Phase 2 extraction preserves behavior.

### Phase 1: Open the Door (3-4 days)

| Task                                                                 | Files                  | Lines |
| -------------------------------------------------------------------- | ---------------------- | ----- |
| Add `hooks` to `ConfigureHttpOptions`                                | types.ts               | +1    |
| Pass hooks through in `buildLazyHttp()`                              | configure.ts           | +3    |
| Define `PluginFactory<T>`, `GlubeanRuntime` types                    | types.ts               | +30   |
| Implement `definePlugin()` helper                                    | plugin.ts              | +5    |
| Implement `buildLazyPlugins()`                                       | configure.ts           | +25   |
| Update `configure()` signature with `plugins` slot                   | configure.ts, types.ts | +10   |
| Remove `graphql` option from `configure()`                           | configure.ts, types.ts | -20   |
| Export `GlubeanRuntime`, `definePlugin`, `resolveTemplate` as public | configure.ts, mod.ts   | +5    |
| Tests for `buildLazyPlugins`                                         | configure_test.ts      | +50   |
| Tests for hooks passthrough                                          | configure_test.ts      | +30   |

**Exit criteria:** `configure({ plugins: { x: definePlugin(...) } })` works with full type inference. HTTP hooks pass
through. All tests green.

**Outcome:** Community can write configure-level plugins and HTTP middleware.

### Phase 2: Dogfooding — Extract & Publish (4-5 days)

Ship `@glubean/graphql` first (validates the architecture on a known module), then `@glubean/auth` (showcases ecosystem
value with a new capability).

Since the SDK hasn't shipped to production users, there's no deprecation period. GraphQL is simply removed from core and
published as a plugin.

| Task                                                          | Files                                                         | Lines           |
| ------------------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| Create `@glubean/graphql` package (monorepo)                  | new package                                                   | ~400 (moved)    |
| Remove all graphql coupling from SDK core                     | types.ts, configure.ts, mod.ts, data.ts, deno.json, README.md | see scope below |
| Create `@glubean/auth` (bearer, basic, apiKey, oauth2)        | new package                                                   | ~300            |
| Tests for both plugins                                        | new test files                                                | ~200            |
| Verify Phase 0 baseline tests pass against `@glubean/graphql` | —                                                             | —               |

#### GraphQL Extraction Scope

| File           | Change                                                                       | Detail                          |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| `graphql.ts`   | **delete** (move wholesale)                                                  | ~400 lines → `@glubean/graphql` |
| `types.ts`     | remove `ConfigureGraphQLOptions`, `GraphQLClient`, `ConfigureResult.graphql` | ~26 references                  |
| `configure.ts` | remove `buildLazyGraphQL`, `buildNoopGraphQL`, related imports               | ~17 references                  |
| `mod.ts`       | remove GraphQL re-exports                                                    | ~9 references                   |
| `data.ts`      | remove `fromGql()` (moves with GraphQL plugin)                               | ~7 references                   |
| `deno.json`    | remove `./graphql` export entry                                              | 1 reference                     |
| `README.md`    | update GraphQL examples to show plugin usage                                 | ~39 references                  |

Total: ~60 code lines to update across 5 source files, plus docs and config. `graphql.ts` itself moves wholesale and
doesn't count as "changes."

**Exit criteria:** `@glubean/graphql` and `@glubean/auth` published to JSR. Phase 0 baseline tests pass against the
plugin version. SDK core has zero GraphQL references.

**Outcome:** Two published plugins prove the architecture works.

### Phase 3: Deep Extension (4-5 days)

| Task                                                               | Files                   | Lines                 |
| ------------------------------------------------------------------ | ----------------------- | --------------------- |
| Implement `test.extend()` with chained extend support              | mod.ts                  | +100                  |
| Add `Ctx` generic to `TestBuilder`                                 | mod.ts, types.ts        | ~20 signature changes |
| Add `Ctx` generic to `EachBuilder`                                 | mod.ts                  | ~15 signature changes |
| Implement `Expectation.extend()`                                   | expect.ts               | +30                   |
| Tighten scanner Pattern 3 regex + fix validation message           | scanner/scanner.ts      | ~10                   |
| Scanner integration tests for `./fixtures.ts` re-export            | scanner/scanner_test.ts | +40                   |
| Tests for `test.extend()` (including chained extends)              | extend_test.ts          | +120                  |
| Tests for `Expectation.extend()`                                   | expect_test.ts          | +50                   |
| Type inference tests (3+ plugins in configure, 3+ chained extends) | type_test.ts            | +40                   |

#### Scanner Compatibility

`test.extend()` encourages a pattern where users re-export `test` from a local `fixtures.ts` file:

```typescript
// tests/fixtures.ts
import { test as base } from "@glubean/sdk";
export const test = base.extend({ auth: ... });

// tests/users.test.ts
import { test } from "./fixtures.ts";
```

The scanner's file-discovery regex (Pattern 3: `/import\s+.*\{[^}]*test[^}]*\}/`) is broad enough to match
`import { test } from "./fixtures.ts"`. This has been verified against the current scanner source. However:

1. **Pattern 3 is overly broad** — it matches `import { testUtils } from "..."`, causing false positives. The runtime
   extractor filters non-test exports, but the regex should be tightened to reduce noise. **This is a Phase 3 task, not
   a follow-up.**

2. **Validation message is misleading** — `validate()` says "import from @glubean/sdk" but Pattern 3 doesn't require
   that. Update the message to reflect reality.

3. **Runtime extraction still works** — `extractor-deno.ts` runs the file in a subprocess and reads from
   `getRegistry()`, which is populated by `test()` regardless of import source. `test.extend()` wraps the original
   `test()`, so the registry chain stays intact.

**Exit criteria:** `test.extend()` and chained extend work with full type inference. Scanner discovers test files using
`./fixtures.ts` re-export pattern. All tests green. `Expectation.extend()` matchers work with `.not` negation and
`.orFail()` chaining.

**Outcome:** Full plugin architecture. Plugins can extend ctx and assertions.

### Phase 4: Ecosystem Enablement (1-2 weeks, NOT optional)

This phase is critical for adoption. Without it, the plugin system is an architecture with no users. This is the
difference between "built it" and "they came."

| Task                                            | Priority      | Why                                      |
| ----------------------------------------------- | ------------- | ---------------------------------------- |
| Plugin author guide                             | **Must-have** | Community can't write plugins without it |
| Template repository (`create-glubean-plugin`)   | **Must-have** | Reduces "blank page" friction to zero    |
| `glubean init --plugin` scaffolding             | High          | Keeps everything in the CLI workflow     |
| Blog post: "Write a Glubean Plugin in 30 Lines" | High          | Demonstrates that the claim is real      |
| AGENTS.md template for plugin repos             | High          | AI agents can assist plugin development  |
| Plugin discovery page on docs site              | Medium        | Visibility for community packages        |

**Exit criteria:** A new developer can create a working plugin from template to published JSR package in under 30
minutes, guided only by the docs. Plugin author guide published. Template repo working. `glubean init --plugin`
generates a buildable scaffold.

### Phase 5: Plugin Visualization (post-cloud-launch)

> **Priority:** This phase starts **after Cloud launches** and after Phase 1–4 are complete. It is not a prerequisite
> for the SDK-side plugin architecture, but it **must be done before we publicly encourage plugins that produce custom
> event types** — otherwise plugin results are invisible on the dashboard.

| Task                                                                                           | Where                | Effort           |
| ---------------------------------------------------------------------------------------------- | -------------------- | ---------------- |
| Open `RunEvent.type` to accept `plugin:*` namespace                                            | `@glubean/contracts` | Small            |
| Add `RenderHint` type to contracts                                                             | `@glubean/contracts` | Small            |
| Add `ctx.emit()` API for plugin-authored events                                                | `@glubean/sdk`       | Medium           |
| Accept `plugin:*` events in Cloud ingestion (pass-through)                                     | ControlPlane         | Small            |
| Implement RenderHint renderer component set (kv, table, code, diff, badge, markdown, timeline) | Cloud viewer         | **Medium-Large** |
| Implement structured fallback card (JSON tree for unknown plugin events)                       | Cloud viewer         | Small            |
| Document `ctx.emit()` + `RenderHint` in plugin author guide                                    | Docs                 | Medium           |
| Add `render` hints to `@glubean/graphql` and `@glubean/auth` events                            | First-party plugins  | Small            |

**Suggested sub-phasing:**

1. **5a — Contracts + SDK** (1–2 days): Open `RunEvent.type`, add `RenderHint`, ship `ctx.emit()`. This unblocks plugin
   authors to start emitting events even before the viewer renders them nicely.
2. **5b — Fallback rendering** (1–2 days): Cloud viewer shows a structured JSON card for any `plugin:*` event. This
   ensures nothing is invisible.
3. **5c — RenderHint renderers** (3–5 days): Implement the kv / table / code / diff / badge / markdown / timeline
   components. Most are composable from existing shadcn primitives.
4. **5d — First-party dogfooding** (1–2 days): Add `render` hints to `@glubean/graphql` and `@glubean/auth` events.
   Update plugin author guide with visualization examples.
5. **5e — Plugin-renderers repo** (evaluate after 5d): If RenderHint proves insufficient for first-party plugins, set up
   the `plugin-renderers` repo (see
   [Solution Candidate B](#solution-candidate-b-community-renderer-repo-for-richer-visualization)). This adds a
   dedicated-renderer layer above RenderHint in the fallback pyramid.

**Exit criteria:** Plugin events with `RenderHint` render correctly in the Cloud dashboard. Plugin events without hints
display a structured fallback card. Plugin author guide documents `ctx.emit()` and render hints with examples.

---

## GraphQL Extraction

The SDK hasn't shipped to production users yet. No deprecation period, no shim layer, no compat re-exports. GraphQL is
simply removed from core and published as `@glubean/graphql`.

| What                     | Before                                   | After                                               |
| ------------------------ | ---------------------------------------- | --------------------------------------------------- |
| GraphQL client           | `import { ... } from "@glubean/sdk"`     | `import { graphql } from "@glubean/graphql"`        |
| `configure({ graphql })` | Built-in option                          | `configure({ plugins: { graphql: graphql(...) } })` |
| `fromGql()` data loader  | `import { fromGql } from "@glubean/sdk"` | `import { fromGql } from "@glubean/graphql"`        |
| GraphQL types            | Exported from `@glubean/sdk`             | Exported from `@glubean/graphql`                    |

This is a clean break, not a migration.

---

## Auth Plugin Design (`@glubean/auth`)

Auth spans multiple hooks because different auth modes have different needs:

| Auth Mode                             | Hook   | Mechanism                                                           |
| ------------------------------------- | ------ | ------------------------------------------------------------------- |
| Static token (Bearer, Basic, API Key) | Hook 2 | Returns `ConfigureHttpOptions` with headers                         |
| OAuth 2.0 Client Credentials          | Hook 4 | Returns `ConfigureHttpOptions` with `beforeRequest` hook            |
| OAuth 2.0 Refresh Token               | Hook 4 | `afterResponse` hook detects 401, refreshes, retries                |
| Dynamic login (multi-step)            | Hook 3 | Builder transform via `.use()` (today) or `test.extend()` (Phase 3) |

### API Surface

```typescript
// Static auth — Hook 2 (configure helpers)
import { apiKey, basicAuth, bearer } from "@glubean/auth";

configure({ http: bearer("base_url", "api_token") });
configure({ http: basicAuth("base_url", "username", "password") });
configure({ http: apiKey("base_url", "X-API-Key", "api_key") });
configure({ http: apiKey("base_url", "api_key", "api_key_secret", "query") });

// OAuth — Hook 4 (HTTP middleware)
import { oauth2 } from "@glubean/auth";

configure({
  http: oauth2.clientCredentials({
    prefixUrl: "base_url",
    tokenUrl: "token_url",
    clientId: "client_id",
    clientSecret: "client_secret",
    scope: "read:users",
  }),
});

// Dynamic login — Hook 3 (builder transform, works today)
import { withLogin } from "@glubean/auth";

test("flow")
  .use(
    withLogin({
      endpoint: "/auth/login",
      credentials: { email: "{{user}}", password: "{{pass}}" },
      extractToken: (body) => body.access_token,
    }),
  )
  .step("test", async (ctx, { authedHttp }) => {
    const me = await authedHttp.get("/me").json();
  });
```

---

## Risk Assessment

### Technical Risks

| Risk                                                             | Severity | Mitigation                                                                                                                                                       |
| ---------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GraphQL extraction introduces behavioral regression**          | Medium   | Phase 0 baseline tests verify before/after equivalence                                                                                                           |
| **Scanner regex too broad (Pattern 3)**                          | Medium   | Phase 3 tightens regex and adds integration tests for `./fixtures.ts` re-export pattern                                                                          |
| **`Expectation.extend()` prototype mutation leaks across tests** | Low      | Not a real risk — each test file runs in its own Deno subprocess (see [Isolation Guarantee](#isolation-guarantee)). Document this so plugin authors don't worry. |
| **`test.extend()` lifecycle (setup/teardown) edge cases**        | Medium   | Thorough tests for: chained extends, error in setup, error in teardown, timeout during teardown. Follow Playwright's patterns.                                   |
| **TypeScript inference fails for complex plugin combos**         | Medium   | Phase 3 includes dedicated type inference tests: 3+ plugins in configure, 3+ chained extends. If inference breaks, provide explicit type overloads.              |
| **Plugin events invisible on Cloud dashboard**                   | Medium   | Phase 5b ships a structured fallback card before RenderHint renderers. No plugin event is ever silently dropped.                                                 |
| **`RenderHint` vocabulary too limited for plugin authors**       | Low      | Start with 7 kinds covering 90%+ of use cases. Add new kinds in core viewer releases based on demand. Fallback card covers the gap.                              |

### Organizational Risks

| Risk                                                 | Severity | Mitigation                                                                                                                                                                     |
| ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No one writes plugins (ecosystem doesn't emerge)** | High     | Phase 4 must-haves (guide, template, init scaffold) ship alongside Phase 3. Dogfood with `@glubean/graphql` and `@glubean/auth` to prove it works.                             |
| **Premature abstraction — hooks are wrong**          | Medium   | Phase 1 + 2 intentionally cover the simplest hooks. `test.extend()` and `Expectation.extend()` ship in Phase 3 only after dogfooding validates the architecture.               |
| **Plugin visualization ships too late**              | Medium   | Phase 5 is post-cloud-launch but must be done before publicly encouraging plugin custom events. Phase 5a–5b (contracts + fallback) can ship quickly to unblock early adopters. |

### What We Explicitly Chose NOT To Do

- **No plugin manifest or `glubean.plugins` config file.** Plugins are code, not configuration. Import them and use
  them. If a declarative config becomes necessary later, it can be layered on without breaking the code-first model.

- **No plugin lifecycle events (init, destroy, pre-test, post-test).** Keep the harness unaware of plugins in Phase 1–3.
  If lifecycle hooks are needed, they can be added to `GlubeanRuntime` in a future phase — but the bar is high, because
  simplicity is more valuable than flexibility at this stage.

- **No plugin compatibility matrix.** Plugins are just functions — they compose via TypeScript's type system. If two
  plugins conflict, it's a runtime error, same as any other function composition bug. No need for a "plugin
  compatibility" framework.

---

## Decision Log

| Decision                                         | Rationale                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No unified Plugin interface                      | Auth, GraphQL, DB plugins touch different hooks. Forcing one interface adds complexity without value. Rollup's model works because bundling plugins naturally cross stages; Glubean plugins typically focus on one hook.                                        |
| `definePlugin()` helper over raw `PluginFactory` | Plugin authors shouldn't need to understand phantom types. `definePlugin()` hides the `__type` trick. All first-party plugins and docs use it.                                                                                                                  |
| Data loaders stay in core                        | ~200 lines, one `@std/yaml` dependency. Extracting adds import cost for users with minimal benefit. Keep as "batteries included."                                                                                                                               |
| `fromGql` moves with GraphQL                     | Only data loader tied to a specific protocol.                                                                                                                                                                                                                   |
| First-party plugins live in the oss monorepo     | `@glubean/graphql` is extracted core code with tight SDK version coupling. Cross-repo version sync in v0.x is pure overhead. Revisit if community maintainers emerge post-v1.0.                                                                                 |
| `test.extend()` supports chained extend          | Playwright's `base → withAuth → withDb` is a proven pattern. Without chaining, all fixtures must live in one `.extend()` call, which doesn't compose in larger projects.                                                                                        |
| Phase 0 before Phase 2                           | Cannot safely extract GraphQL without behavioral test baseline. No existing tests means no safety net for extraction.                                                                                                                                           |
| Phase 1 doesn't touch harness                    | All changes in SDK layer (types.ts, configure.ts, mod.ts). Runner/harness is unaware of plugins. Minimizes risk.                                                                                                                                                |
| GraphQL first, auth second (Phase 2)             | GraphQL validates extraction (known code moving to new home). Auth validates creation (new capability built as plugin from scratch). Both must succeed for the architecture to be credible.                                                                     |
| No deprecation window for GraphQL                | The SDK hasn't shipped to production users. Clean break, not gradual migration.                                                                                                                                                                                 |
| `test.extend()` deferred to Phase 3              | `configure({ plugins })` covers 80% of use cases (GraphQL, auth, gRPC). `test.extend()` is additive for ctx-level extensions. Shipping Phase 2 plugins first proves the architecture before adding complexity.                                                  |
| `Expectation.extend()` uses module augmentation  | Same approach as Jest/Vitest. TypeScript limitation — no way to dynamically add methods with type safety without `declare module`.                                                                                                                              |
| `GlubeanRuntime` is a stability surface          | Fields may be added (minor version), but existing field semantics must not change without a major version bump. This is the contract between the SDK and all plugins.                                                                                           |
| Phase 4 is not optional                          | A plugin system without docs, templates, and scaffolding is an architecture exercise, not a product. Phase 4 ships alongside Phase 3.                                                                                                                           |
| Plugin visualization has two solution candidates | Candidate A (RenderHint): data-driven, zero-friction, core-controlled. Candidate B (plugin-renderers repo): full React expressiveness, community-contributed, AI-assisted review. Start with A, evaluate B after Cloud launches. They are complementary layers. |
| `RenderHint` vocabulary is core-controlled       | New hint kinds are added via core viewer releases, not by plugins. Keeps rendering bounded and quality-assured. Plugins can request new kinds.                                                                                                                  |
| Phase 5 is post-cloud-launch                     | Visualization requires a running Cloud dashboard. Phase 1–4 (SDK-side) can proceed independently. Phase 5a (contracts) should ship early to unblock plugin authors.                                                                                             |
| `RunEvent.type` uses `plugin:` prefix namespace  | Backward-compatible — existing `KnownEventType` values unchanged. Prefix enables ingestion-time routing and viewer fallback logic without ambiguity.                                                                                                            |

---

## Open Questions

These don't block Phase 1 but should be resolved before the relevant phase.

### Before Phase 4

1. **Plugin naming convention: `@glubean/X` vs `glubean-plugin-X`?** First-party: `@glubean/X`. Community: either
   `@scope/glubean-X` or `glubean-X`. Should we recommend or enforce a convention?

2. **Should there be a "blessed plugins" list on the docs site?** Helps discoverability but creates maintenance burden.
   Can start with a simple table in the docs and evolve into an automated registry later.

### Before Phase 5

3. **Should `ctx.emit()` validate the `plugin:` prefix at runtime?** Strict validation prevents accidental collision
   with `KnownEventType`. But it adds a runtime check to every emit call. Likely worth it for safety — decide when
   implementing Phase 5a.

4. **How should the `markdown` render hint be sanitized?** Options: DOMPurify, remark with no HTML plugin, or a custom
   allowlist. Must strip raw HTML, scripts, and external resource references.

5. **Should `RenderHint` support composition (multiple hints per event)?** E.g. a GraphQL query event might want both a
   `code` block and a `kv` summary. Current design is single hint per event — composition could be added later by
   allowing `kind: "group"` with children.

6. **When should the `plugin-renderers` repo (Candidate B) be created?** Evaluate after Phase 5d. If first-party plugins
   need visualization beyond what RenderHint can express, create the repo with shared component library, Storybook, and
   `CONTRIBUTING.md` / `AGENTS.md` for AI-assisted review. If RenderHint is sufficient, defer.

### Resolved Questions

| Question                                          | Resolution                                     | Logged In             |
| ------------------------------------------------- | ---------------------------------------------- | --------------------- |
| Monorepo vs separate repo for `@glubean/graphql`? | Monorepo. Cross-repo sync is overhead in v0.x. | Decision Log          |
| Deprecation window for `configure({ graphql })`?  | None. SDK hasn't shipped. Clean break.         | Decision Log          |
| Chained `test.extend()`?                          | Yes. Required for composable fixtures.         | Decision Log, Phase 3 |
| Scanner regex refinement?                         | Promoted to Phase 3 hard task.                 | Phase 3 task list     |
