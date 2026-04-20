# @glubean/graphql

GraphQL for [Glubean](https://glubean.dev). This package owns two layers:

- **Contract** — author GraphQL API intent as a single artifact (`contract.graphql.with(...)`). Executable spec, agent-readable, fits `contract.flow()` composition. **Recommended for new work.**
- **Transport / test plugin** — thin wrapper over `ctx.http` with operation-name tracing, used via `configure({ plugins: { ... } })` or `createGraphQLClient(...)`. Still supported for test-after / exploratory work.

> **v0.2.0 single-package release note:** in earlier drafts, GraphQL contract was planned as a separate `@glubean/contract-graphql` package. Decision 2026-04-20: one package per protocol. Importing `@glubean/graphql` now registers the contract adapter as a side effect. No new install, no second package.

## Install

```bash
npm install @glubean/graphql
```

No native peer dependencies — the client runs over `ctx.http` (ky).

---

## Quick Start — Contract

```ts
import { contract, configure } from "@glubean/sdk";
import { graphql, gql } from "@glubean/graphql";
// ^ importing @glubean/graphql registers contract.graphql side-effect

const { api } = configure({
  plugins: {
    api: graphql({
      endpoint: "{{GRAPHQL_URL}}",
      headers: { Authorization: "Bearer {{API_TOKEN}}" },
    }),
  },
});

const userContracts = contract.graphql.with("user-api", {
  client: api,
});

export const getUser = userContracts("get-user", {
  endpoint: "/graphql",
  description: "Fetch a user by id",
  cases: {
    happy: {
      description: "existing user returns name + email",
      query: gql`
        query GetUser($id: ID!) {
          user(id: $id) { id name email }
        }
      `,
      variables: { id: "u_123" },
      expect: {
        httpStatus: 200,
        data: { user: { id: "u_123", name: "Alice" } },
        errors: "absent",
      },
    },
    unauth: {
      description: "missing token yields 401",
      query: `query Me { me { id } }`,
      headers: {},
      expect: { httpStatus: 401, errors: "any" },
    },
    forbidden: {
      description: "server returns FORBIDDEN on scope mismatch",
      query: `query AdminOnly { admin { key } }`,
      expect: {
        httpStatus: 200,
        errors: [{ extensions: { code: "FORBIDDEN" } }],
      },
    },
  },
});
```

Run with `glubean run`. Each case becomes a first-class test; failure surfaces HTTP status + GraphQL errors on the trace.

### Cases in a flow

Contract cases compose into `contract.flow()` steps — the same artifact serves both single-case and multi-step verification, **across protocols**:

```ts
import { contract } from "@glubean/sdk";
import { createOrder } from "./orders.contract.ts";   // HTTP
import { completePayment } from "./payment.contract.ts"; // gRPC
import { notifyUser } from "./notify.contract.ts";    // GraphQL

export const checkoutFlow = contract
  .flow("checkout-with-notify")
  .meta({
    description: "Create order → complete payment → notify user",
    tags: ["e2e"],
  })
  // Step 1: HTTP — create order
  .step(createOrder.case("happy"), {
    out: (_s, res: any) => ({ orderId: res.body.id, userId: res.body.userId }),
  })
  // Step 2: gRPC — complete payment
  .step(completePayment.case("happy"), {
    in: (s: any) => ({ request: { orderId: s.orderId } }),
    out: (s, res: any) => ({ ...s, paymentId: res.message.paymentId }),
  })
  // Step 3: GraphQL — notify
  .step(notifyUser.case("orderComplete"), {
    in: (s: any) => ({ variables: { userId: s.userId, orderId: s.orderId } }),
  });
```

Flow state threads through via typed `in` / `out` lenses.

### What you get

- **Selection-set-per-case** — each case owns its own `query` and response schema (`expect.schema` or partial `data`). Contract-level types declaration is optional (`types: { User: { id: "ID!", ... } }`, Phase 2 projection hint).
- **Case-level lifecycle** — mark cases `deferred` (with reason) or `deprecated` (with replacement hint).
- **Structured failure classification (3-layer)** — HTTP transport (4xx/5xx) → payload `errors` (with `extensions.code`) → error shape. Maps to `transient` / `client` / `semantic` / `auth` / `server` kinds; `429` / `503` / `504` marked `retryable`.
- **Envelope exposure** — `GraphqlCaseResult` surfaces `httpStatus`, `headers`, `rawBody` alongside `data` / `errors` for negative-case assertions and flow `out` lens inspection.
- **Projection to Markdown** — case inventory with operation / `operationName` / query snippets, via `glubean contracts`.
- **Flow composition** — mix with HTTP / gRPC cases, same artifact.
- **Scanner + MCP integration** — `glubean scan`, `glubean_extract_contracts` MCP tool, all work unchanged for `contract.graphql(...)`.

---

## Quick Start — Transport / test plugin (low-level)

For quick tests or exploratory work that doesn't need a declared contract:

```ts
import { test, configure } from "@glubean/sdk";
import { graphql } from "@glubean/graphql";

const { gql } = configure({
  plugins: {
    gql: graphql({
      endpoint: "{{GRAPHQL_URL}}",
      headers: { Authorization: "Bearer {{API_TOKEN}}" },
    }),
  },
});

export const getUser = test("get-user", async (ctx) => {
  const { data, errors } = await gql.query<{ user: { name: string } }>(`
    query GetUser($id: ID!) { user(id: $id) { name } }
  `, { variables: { id: "u_123" } });

  ctx.expect(errors).toBeUndefined();
  ctx.expect(data?.user.name).toBe("Alice");
});
```

### Standalone (without `configure()`)

```ts
import { test } from "@glubean/sdk";
import { createGraphQLClient } from "@glubean/graphql";

export const quick = test("quick-gql", async (ctx) => {
  const gql = createGraphQLClient(ctx.http, {
    endpoint: "https://api.example.com/graphql",
  });
  const res = await gql.query(`{ health }`);
  ctx.assert(res.data?.health === "ok", "Service healthy");
  ctx.expect(res.httpStatus).toBe(200);
});
```

---

## API Reference

### Contract

#### `contract.graphql.with(instanceName, defaults?)`

Returns a scoped factory. Direct `contract.graphql("id", spec)` is not supported — use `.with(...)` first.

Instance defaults (`GraphqlContractDefaults`):

| Option | Type | Description |
|--------|------|-------------|
| `client` | `GraphQLClient` | Default client (from `configure({ plugins })`) |
| `endpoint` | `string` | Default endpoint (fallback if neither client nor spec provides one) |
| `tags` | `string[]` | Tags inherited by all contracts in this instance |
| `feature` | `string` | Grouping key for projection |
| `headers` | `Record<string, string>` | Default headers merged into every case |
| `extensions` | `Extensions` | Projection-level extensions (x-* keys) |

#### `contract.graphql.with(...)("contractId", spec)`

Creates one contract. Spec shape (`GraphqlContractSpec`):

| Field | Type | Description |
|-------|------|-------------|
| `endpoint` | `string` | Endpoint URL (falls back to client endpoint / instance default) |
| `description` | `string` | Contract-level description |
| `types` | `GraphqlTypeDefs` | Explicit type declarations (Phase 2 `.gql` projection hint; opaque in Phase 1) |
| `defaultOperation` | `"query" \| "mutation"` | Default operation type for cases (default: `"query"`) |
| `variablesSchema` | `SchemaLike<Vars>` | Contract-level variables schema |
| `responseSchema` | `SchemaLike<Res>` | Contract-level response schema (rare — per-case `expect.schema` is the primary home) |
| `defaultVariables` | `Partial<Vars>` | Deep-merged under each case's `variables` |
| `defaultHeaders` | `Record<string, string>` | Merged under each case's `headers` |
| `client` | `GraphQLClient` | Override instance client |
| `cases` | `Record<string, GraphqlContractCase>` | Named cases — required |

Case shape (`GraphqlContractCase<Vars, Res, S>`):

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | Required — why this case exists |
| `query` | `string` | Required — GraphQL document (inline, `gql` tag, or `fromGql("./file.gql")`) |
| `operation` | `"query" \| "mutation"` | Override spec-level default (`subscription` is Phase 2) |
| `operationName` | `string` | Display hint; defaults to parse from `query` |
| `variables` | `Vars \| (state) => Vars` | Variables; deep-merged over `defaultVariables` |
| `headers` | `Record<string, string> \| fn` | Per-call headers |
| `endpoint` | `string` | Per-case endpoint override (rare) |
| `expect` | `GraphqlContractExpect<Res>` | `httpStatus` / `data` / `errors` / `schema` / `headers` / `headersMatch` |
| `setup` / `teardown` | `(ctx, state?) => Promise<void>` | Lifecycle |
| `verify` | `(ctx, GraphqlCaseResult) => Promise<void>` | Business-logic check after transport + schema + data assertions |
| `deferred` | `string` | Skip with reason |
| `deprecated` | `string` | Deprecate with reason |
| `tags` / `severity` / `requires` / `defaultRun` | — | Standard case metadata |

`expect` fields:

| Field | Type | Description |
|-------|------|-------------|
| `httpStatus` | `number` | Expected HTTP status from the POST (default: `200`) |
| `schema` | `SchemaLike<Res>` | Per-case response schema (selection-set-coupled); validated via `ctx.validate` |
| `data` | `Partial<Res>` | Partial match on response `data` |
| `errors` | `GraphqlErrorsExpect` | `"absent"` (default) \| `"any"` \| `Array<Partial<GraphQLError>>` |
| `headers` | `SchemaLike<Record<string, string \| string[]>>` | Schema for response headers |
| `headersMatch` | `Record<string, string>` | Partial match on response headers |

`GraphqlCaseResult<Res>` — shape passed to `verify` and flow `out` lens:

| Field | Type | Description |
|-------|------|-------------|
| `data` | `Res \| null` | Decoded `data` field (null if all fields errored or transport failed) |
| `errors` | `GraphQLError[] \| undefined` | Payload errors array |
| `extensions` | `Record<string, unknown>` | Server-side tracing/cost/etc |
| `httpStatus` | `number` | HTTP status from the underlying POST |
| `headers` | `Record<string, string \| string[]>` | Response headers (lowercased keys) |
| `rawBody` | `string \| null` | Raw response body (null on network error) |
| `operationName` | `string` | Resolved operation name |
| `duration` | `number` | Call duration in ms |

### Transport

#### `graphql(options)` — Plugin Factory

For use with `configure({ plugins })`. Supports `{{template}}` placeholders in `endpoint` and `headers` values, resolved from Glubean vars and secrets.

| Option | Type | Description |
|--------|------|-------------|
| `endpoint` | `string` | GraphQL endpoint URL, supports `{{VAR}}` |
| `headers` | `Record<string, string>` | Default headers, supports `{{VAR}}` |
| `throwOnGraphQLErrors` | `boolean` | Throw `GraphQLResponseError` when the response carries `errors` (default: `false`) |

#### `createGraphQLClient(http, options)` — Standalone

Returns a `GraphQLClient` bound to `http` (typically `ctx.http`).

#### `client.query(query, options?)` / `client.mutate(mutation, options?)`

Returns `GraphQLResult<T>`:

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T \| null` | Parsed response data |
| `errors` | `GraphQLError[] \| undefined` | Payload errors |
| `extensions` | `Record<string, unknown>` | Server extensions |
| `httpStatus` | `number` | HTTP status |
| `headers` | `Record<string, string \| string[]>` | Response headers |
| `rawBody` | `string \| null` | Raw body |

Options:

| Option | Type | Description |
|--------|------|-------------|
| `variables` | `Record<string, unknown>` | Query variables |
| `operationName` | `string` | Override auto-parsed name |
| `headers` | `Record<string, string>` | Extra per-request headers |

Errors don't throw by default — inspect `errors` / `httpStatus` for assertion-friendly testing. Opt into throws via `throwOnGraphQLErrors: true`.

#### `gql` — tagged template

Identity function; exists so IDE GraphQL extensions pick up syntax highlighting.

#### `fromGql(path)` — `.gql` file loader

Reads a GraphQL document file relative to the test file. Prefer this for full IDE support (autocomplete, schema validation) when you've got a `.graphqlrc`.

---

## Tracing

Every GraphQL call inherits HTTP-level tracing via `ctx.http` and injects `X-Glubean-Op: <operationName>` so individual operations are distinguishable in the dashboard instead of showing a generic `POST /graphql`.

The underlying HTTP trace event already carries status, timing, and request/response bodies. At the contract layer, `classifyFailure` consumes `graphql_response` / `http_response` events and maps to the repair-loop `FailureKind` values.

## Auth

Static headers (including auth tokens) are sent with every call:

```ts
graphql({
  // ...
  headers: { Authorization: "Bearer {{API_TOKEN}}" },
});
```

Per-call headers override static values:

```ts
await gql.query(`{ me { id } }`, {
  headers: { Authorization: "Bearer per-call-token" },
});
```

At the contract layer, headers merge in this order (right wins):
instance `defaults.headers` < contract `defaultHeaders` < case `headers` < flow-step `in` lens `headers`.

---

## Migration: 0.1.x → 0.2.0

**What's new:**
- Contract adapter shipped inside this package. `import "@glubean/graphql"` now also registers `contract.graphql.with(...)`.
- Single-package model: no separate `@glubean/contract-graphql` package.
- `GraphQLClient.query` / `.mutate` return `GraphQLResult<T>` — additive over `GraphQLResponse<T>`: same `data` / `errors` / `extensions`, plus new `httpStatus` / `headers` / `rawBody`.

**What's not broken:**
- Existing `configure({ plugins: { x: graphql({ ... }) } })` usage is unchanged.
- Existing `createGraphQLClient(...)` usage is unchanged.
- Code that destructures `{ data, errors }` from query/mutation calls continues to work — new fields are additive.
- All 0.1.x transport tests still pass without modification.

**Only additive API changes:**
- `contract.graphql.with(...)` now available from `@glubean/sdk` after importing this package.
- `GraphQLResult<T>` is exported alongside `GraphQLResponse<T>` and is returned from client methods.
- Export surface gained contract types (`GraphqlContractSpec`, `GraphqlContractCase`, etc.).

If you currently use `@glubean/graphql` only as a transport plugin and do not import `contract.graphql` anywhere, you only need to rebuild; no source changes are required.

## Scope

### Phase 1 (shipped)

- Query + mutation contracts (selection-set-per-case)
- 3-layer failure classification (transport / payload / error shape)
- Per-case schema validation (selection-set coupled)
- Headers + variables merge through contract → instance → case → flow-step
- Envelope exposure (`httpStatus` / `headers` / `rawBody`)
- Markdown projection (case list + operation + query snippets + lifecycle markers)
- Cross-protocol flow composition (HTTP + gRPC + GraphQL verified end-to-end)

### Phase 2 (planned)

- Subscription support sharing the same streaming case design as gRPC streaming
- `.gql` / SDL projection from `types` declaration (see proposal §7b — solvable, sequencing deferral)
- See `internal/40-discovery/proposals/contract-async-protocol-plugins.md`

### Out of scope (Phase 3+)

- Federated gateways / schema stitching
- Apollo Studio / Hasura registry integration
- Persistent queries
- Automatic `.gql` SDL generation as the only source of truth — see proposal §7b.4 for long-term framing

---

## License

MIT
