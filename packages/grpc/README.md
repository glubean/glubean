# @glubean/grpc

gRPC plugin for [Glubean](https://glubean.dev) — workflow-level gRPC testing with built-in tracing.

## Install

```bash
npm install @glubean/grpc @grpc/grpc-js @grpc/proto-loader
```

`@grpc/grpc-js` and `@grpc/proto-loader` are peer dependencies — you install them alongside the plugin.

## Quick Start

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

## Standalone (without `configure()`)

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

## API

### `grpc(options)` — Plugin Factory

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

### `createGrpcClient(options, hooks?)` — Standalone

Same options as above (without template support). Optional `hooks` parameter for instrumentation:

```ts
createGrpcClient(options, {
  event: (ev) => { /* trace event */ },
});
```

### `client.call(method, request, options?)`

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

### `client.close()`

Close the underlying gRPC channel.

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

These traces share the same event channel as HTTP traces, enabling unified timeline rendering in the Glubean dashboard.

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

## Scope

This is a v1 focused on unary RPC. Not included:

- Server / client / bidirectional streaming
- Reflection-based service discovery
- Static codegen / type generation
- grpc-web / Connect RPC
- Retry policies

## License

MIT
