# @glubean/grpc

gRPC for [Glubean](https://glubean.dev). This package owns two layers:

- **Contract** — author gRPC API intent as a single artifact (`contract.grpc.with(...)`). Executable spec, agent-readable, fits `contract.flow()` composition. **Recommended for new work.**
- **Transport plugin** — low-level gRPC client with auto-tracing, used via `configure({ plugins: { ... } })`. Still supported for test-after / exploratory work.

> **v0.2.0 single-package release note:** in earlier drafts, gRPC contract was planned as a separate `@glubean/contract-grpc` package. Decision 2026-04-20: one package per protocol. The package now ships a plugin manifest; install it explicitly from `glubean.setup.ts` to enable `contract.grpc`.

## Install

```bash
npm install @glubean/grpc @grpc/grpc-js @grpc/proto-loader
```

`@grpc/grpc-js` and `@grpc/proto-loader` are peer dependencies.

Install the contract plugin in your project setup:

```ts
// glubean.setup.ts
import { installPlugin } from "@glubean/sdk";
import grpcPlugin from "@glubean/grpc";

await installPlugin(grpcPlugin);
```

---

## Quick Start — Contract

```ts
import { contract, configure } from "@glubean/sdk";
import { grpc } from "@glubean/grpc";
import { z } from "zod";

const { payment } = configure({
  plugins: {
    payment: grpc({
      proto: "./protos/payment.proto",
      address: "{{PAYMENT_SERVICE_ADDR}}",
      package: "acme.payment.v1",
      service: "PaymentService",
    }),
  },
});

const paymentContracts = contract.grpc.with("payment-api", {
  client: payment,
});

export const completePayment = paymentContracts("complete-payment", {
  target: "PaymentService/Complete",
  description: "Complete a pending payment by order id + amount",
  cases: {
    happy: {
      description: "order with valid payment method completes successfully",
      needs: z.object({ orderId: z.string(), amount: z.number() }),
      request: ({ orderId, amount }) => ({ orderId, amount, currency: "USD" }),
      expect: {
        statusCode: 0, // OK
        message: { status: "completed" },
      },
    },
    notFound: {
      description: "unknown order id returns NOT_FOUND",
      request: { orderId: "does-not-exist" },
      expect: {
        statusCode: 5, // NOT_FOUND
      },
    },
  },
});
```

Run with `glubean run`. Each case becomes a first-class test; failure surfaces structured gRPC status on the trace.

### Cases in a flow

Contract cases compose into `contract.flow()` steps — the same artifact serves both single-case and multi-step verification:

```ts
import { contract } from "@glubean/sdk";
import { completePayment } from "./payment.contract.ts";
import { createOrder, getOrder } from "./orders.contract.ts"; // HTTP

export const checkoutFlow = contract
  .flow("checkout")
  .meta({
    description: "Create order → complete payment → confirm",
    tags: ["e2e"],
  })
  // Step 1: HTTP — create order
  .step(createOrder.case("happy"), {
    out: (_s, res: any) => ({ orderId: res.body.id, amount: res.body.total }),
  })
  // Step 2: gRPC — complete payment
  .step(completePayment.case("happy"), {
    in: (s: any) => ({ orderId: s.orderId, amount: s.amount }),
    out: (s, res: any) => ({ ...s, paymentId: res.message.paymentId }),
  })
  // Step 3: HTTP — confirm
  .step(getOrder.case("byId"), {
    in: (s: any) => ({ id: s.orderId }),
  });
```

Flow state threads through via typed `in` / `out` lenses, **across protocols**.

### What you get

- **Case-level lifecycle** — mark cases `deferred` (with reason) or `deprecated` (with replacement hint)
- **Structured failure classification** — gRPC status codes map to `transient` / `client` / `semantic` / `auth` / `server` kinds; transient codes (1 CANCELLED, 4 DEADLINE_EXCEEDED, 8 RESOURCE_EXHAUSTED, 14 UNAVAILABLE) marked `retryable`
- **Projection to Markdown** — case inventory with lifecycle markers, via `glubean contracts`
- **Flow composition** — mix with HTTP / GraphQL cases, same artifact
- **Scanner + MCP integration** — `glubean scan`, `glubean_extract_contracts` MCP tool, all work unchanged for `contract.grpc.with(...)`

---

## Quick Start — Transport plugin (low-level)

For quick tests or exploratory work that doesn't need a declared contract:

```ts
import { test, configure } from "@glubean/sdk";
import { grpc } from "@glubean/grpc";

const { users } = configure({
  plugins: {
    users: grpc({
      proto: "./protos/users.proto",
      address: "{{USER_SERVICE_ADDR}}",
      package: "acme.users.v1",
      service: "UsersService",
      metadata: { authorization: "Bearer {{API_TOKEN}}" },
    }),
  },
});

export const getUser = test("get-user", async (ctx) => {
  const res = await users.call("GetUser", { id: "u_123" });
  ctx.expect(res.status.code).toBe(0);
  ctx.expect(res.message.user.id).toBe("u_123");
});
```

### Standalone (without `configure()`)

```ts
import { createGrpcClient } from "@glubean/grpc";

const client = createGrpcClient({
  proto: "./protos/billing.proto",
  address: "localhost:50051",
  package: "acme.billing.v1",
  service: "BillingService",
});

const res = await client.call("CreateInvoice", {
  customer_id: "cus_123",
  amount_cents: 1200,
});

console.log(res.status.code); // 0 = OK
console.log(res.message);     // decoded response
console.log(res.duration);    // ms

client.close();
```

---

## API Reference

### Contract

#### `contract.grpc.with(instanceName, defaults?)`

Returns a scoped factory. Direct `contract.grpc("id", spec)` is not supported — use `.with(...)` first.

Instance defaults (`GrpcContractDefaults`):

| Option | Type | Description |
|--------|------|-------------|
| `client` | `GrpcClient` | Default client (from `configure({ plugins })`) |
| `tags` | `string[]` | Tags inherited by all contracts in this instance |
| `feature` | `string` | Grouping key for projection |
| `metadata` | `Record<string, string>` | Default metadata for all contracts |
| `deadlineMs` | `number` | Default deadline |
| `extensions` | `Extensions` | Projection-level extensions (x-* keys) |

#### `contract.grpc.with(...)("contractId", spec)`

Creates one contract. Spec shape (`GrpcContractSpec`):

| Field | Type | Description |
|-------|------|-------------|
| `target` | `string` | Wire target `"Service/Method"` — renders as `"Service.Method"` in UI |
| `description` | `string` | Contract-level description |
| `requestSchema` | `SchemaLike<Req>` | Contract-level request schema (for projection) |
| `defaultRequest` | `Partial<Req>` | Merged under each case's `request` |
| `defaultMetadata` | `Record<string, string>` | Merged under each case's `metadata` |
| `deadlineMs` | `number` | Contract-level deadline |
| `client` | `GrpcClient` | Override instance client |
| `cases` | `Record<string, GrpcContractCase>` | Named cases — required |

Case shape (`GrpcContractCase<Req, Res, S>`):

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | Required — why this case exists |
| `request` | `Req \| (state) => Req` | Request message; deep-merged over contract defaults |
| `metadata` | `Record<string, string> \| fn` | Per-call metadata |
| `deadlineMs` | `number` | Per-call deadline override |
| `expect` | `GrpcContractExpect<Res>` | `statusCode` / `schema` / `message` / `metadata` / `metadataMatch` |
| `setup` / `teardown` | `(ctx, state?) => Promise<void>` | Lifecycle |
| `verify` | `(ctx, GrpcCaseResult) => Promise<void>` | Business-logic check after other assertions |
| `deferred` | `string` | Skip with reason |
| `deprecated` | `string` | Deprecate with reason |
| `tags` / `severity` / `requires` / `defaultRun` | — | Standard case metadata |

`expect` fields:

| Field | Type | Description |
|-------|------|-------------|
| `statusCode` | `number` | Expected gRPC status code (default: `0` / OK) |
| `schema` | `SchemaLike<Res>` | Response schema; validated via `ctx.validate` |
| `message` | `Partial<Res>` | Partial match on response message |
| `metadata` | `SchemaLike<Record<string, string>>` | Schema for trailing metadata |
| `metadataMatch` | `Record<string, string>` | Partial match on trailing metadata |

`GrpcCaseResult<Res>` — shape passed to `verify` and flow `out` lens:

| Field | Type |
|-------|------|
| `message` | `Res` |
| `status.code` / `status.details` | `number` / `string` |
| `responseMetadata` | `Record<string, string>` |
| `duration` | `number` (ms) |

### Transport

#### `grpc(options)` — Plugin Factory

For use with `configure({ plugins })`. Supports `{{template}}` placeholders in `address` and `metadata` values, resolved from Glubean vars and secrets.

| Option | Type | Description |
|--------|------|-------------|
| `proto` | `string` | Path to `.proto` file |
| `address` | `string` | Server address (`host:port`), supports `{{VAR}}` |
| `package` | `string` | Protobuf package name |
| `service` | `string` | Service name |
| `metadata` | `Record<string, string>` | Static metadata, supports `{{VAR}}` |
| `tls` | `boolean` | Use TLS (default: `false`) |
| `deadlineMs` | `number` | Default deadline in ms (default: `30000`) |

#### `createGrpcClient(options, hooks?)` — Standalone

Same options as above (without template support). Optional `hooks` parameter:

```ts
createGrpcClient(options, {
  event: (ev) => { /* trace event */ },
});
```

#### `client.call(method, request, options?)`

Make a unary RPC call.

```ts
const res = await client.call("GetUser", { id: "u_123" }, {
  deadlineMs: 5000,
  metadata: { "x-request-id": "abc" },
});
```

Returns `GrpcCallResult`:

| Field | Type | Description |
|-------|------|-------------|
| `message` | `T` | Decoded response |
| `status.code` | `number` | gRPC status code (0 = OK) |
| `status.details` | `string` | Status details |
| `duration` | `number` | Call duration in ms |
| `responseMetadata` | `Record<string, string>` | Server response metadata |

Errors don't throw — they return with a non-zero `status.code` for assertion-friendly testing.

#### `client.close()`

Close the underlying gRPC channel.

---

## Custom matchers

Installing the `@glubean/grpc` plugin manifest from `glubean.setup.ts`
registers gRPC matchers onto the shared `ctx.expect()` surface.

```ts
// Works on GrpcCallResult (transport) and GrpcCaseResult (contract verify / flow out lens)
ctx.expect(res).toHaveGrpcStatus(0);                  // exact code
ctx.expect(res).toHaveGrpcOk();                       // convenience for code 0
ctx.expect(res).toHaveGrpcStatus(5, "user lookup");   // with context label
ctx.expect(res).toHaveGrpcMetadata("x-request-id");   // presence
ctx.expect(res).toHaveGrpcMetadata("x-tenant", "acme"); // value
ctx.expect(res).not.toHaveGrpcStatus(0);              // negation
```

All matchers inherit `.not` negation, `.orFail()` chaining, and soft-by-default
semantics from `@glubean/sdk`'s `Expectation`. Types come through
`CustomMatchers<T>` declaration merging automatically — no user-side
`declare module` required.

---

## Tracing

Every RPC call emits a single `trace` event with the full request/response cycle:

| Field | Type | Description |
|-------|------|-------------|
| `protocol` | `"grpc"` | Protocol discriminator |
| `target` | `string` | `Service/Method` |
| `status` | `number` | gRPC status code (0 = OK) |
| `durationMs` | `number` | Call duration in ms |
| `ok` | `boolean` | `true` if status is 0 |
| `service` | `string` | Service name |
| `method` | `string` | RPC method name |
| `peer` | `string` | Server address |
| `request` | `object` | Request payload |
| `response` | `object` | Response payload (success only) |
| `metadata` | `object` | Merged request metadata (static + per-call) |

Traces share the same event channel as HTTP — enables unified timeline rendering in the Glubean dashboard and cross-protocol flow inspection.

## Auth

Static metadata (including auth tokens) is sent with every call:

```ts
grpc({
  // ...
  metadata: { authorization: "Bearer {{API_TOKEN}}" },
});
```

Per-call metadata overrides static values:

```ts
await client.call("GetUser", { id: "u_123" }, {
  metadata: { authorization: "Bearer per-call-token" },
});
```

At the contract layer, metadata merges in this order (right wins):
instance `defaults.metadata` < contract `defaultMetadata` < case `metadata` < flow-step `in` lens `metadata`.

---

## Migration: 0.1.x → 0.2.0

**What's new:**
- Contract adapter shipped inside this package. `import "@glubean/grpc"` now also registers `contract.grpc.with(...)`.
- Single-package model: no separate `@glubean/contract-grpc` package.

**What's not broken:**
- Existing `configure({ plugins: { x: grpc({ ... }) } })` usage is unchanged.
- Existing `createGrpcClient(...)` usage is unchanged.
- All 0.1.x transport tests still pass without modification.

**Only additive API changes:**
- `contract.grpc.with(...)` now available from `@glubean/sdk` after importing this package.
- Export surface gained contract types (`GrpcContractSpec`, `GrpcContractCase`, etc.).

If you currently use `@glubean/grpc` only as a transport plugin and do not import `contract.grpc` anywhere, no migration is required.

## Scope

### Phase 1 (shipped)

- Unary RPC calls (contract + transport layers)
- Status code assertions + schema validation
- Response metadata match
- Deadline + metadata merge through contract → instance → case → flow-step
- gRPC status → FailureKind classification for repair loop
- Markdown projection (case list + lifecycle markers)
- Cross-protocol flow composition (HTTP + gRPC verified end-to-end)

### Phase 2 (planned)

- Server / client / bidirectional streaming
- GraphQL subscription sharing the same streaming case design
- See `internal/40-discovery/proposals/contract-async-protocol-plugins.md`

### Out of scope (Phase 3+)

- Reflection-based service discovery
- grpc-gateway / HTTP transcoding projection
- Buf schema registry integration
- Generating `.proto` from contract (solvable via annotation passthrough, but deferred — see proposal §7b)

---

## License

MIT
