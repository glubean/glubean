# @glubean/redaction

Scope-based secrets/PII detection and masking for [Glubean](https://glubean.dev).

## Overview

Redaction v2 uses a data-driven scope model. Scopes declare **what** to redact (event type + field path + rules). Handlers declare **how** to interpret payloads (JSON, headers, URL query strings). Plugins provide detection logic (sensitive keys, value patterns).

All scope declarations — built-in HTTP, gRPC, or any future protocol — use the same shape. No hardcoded protocol knowledge in the redaction package.

## Quick Start

```ts
import {
  compileScopes,
  redactEvent,
  BUILTIN_SCOPES,
  DEFAULT_GLOBAL_RULES,
} from "@glubean/redaction";

// Compile scopes once at startup
const scopes = compileScopes({
  builtinScopes: BUILTIN_SCOPES,
  globalRules: DEFAULT_GLOBAL_RULES,
  replacementFormat: "partial",
});

// Redact events
const event = {
  type: "trace",
  data: {
    requestHeaders: { authorization: "Bearer secret-token" },
    requestBody: { password: "hunter2", username: "alice" },
  },
};

const redacted = redactEvent(event, scopes, "partial");
// redacted.data.requestHeaders.authorization → "Bea***123"
// redacted.data.requestBody.password → "hun***er2"
// redacted.data.requestBody.username → "alice" (not sensitive)
```

## Architecture

```
scope declarations (built-in + plugins + user overrides)
  → compile to CompiledScope[]
    → redactEvent(event, compiledScopes)
      → for each matching scope:
        1. extract target value via field path
        2. run the scope's handler
        3. handler calls engine with per-scope plugin pipeline
        4. write redacted value back
```

### Scopes

A scope declares where to redact and what rules apply:

```ts
{
  id: "http.request.headers",
  name: "HTTP request headers",
  event: "trace",
  target: "data.requestHeaders",
  handler: "headers",
  rules: {
    sensitiveKeys: ["authorization", "cookie"],
  },
}
```

- `id` — stable config key for user overrides
- `event` — which event type to match
- `target` — dot-path to the payload field
- `handler` — which handler interprets the payload
- `rules` — scope-specific sensitive keys and patterns

### Handlers

Built-in handlers:

| Handler | Purpose |
|---------|---------|
| `json` | Recursive JSON object/array walker |
| `raw-string` | Value-pattern matching on plain strings |
| `url-query` | Parse URL (absolute or relative), redact query params, serialize back |
| `headers` | Header map with cookie/set-cookie parsing (cookie values masked structurally) |
| `body` | HTTP body: object → JSON walk; string → JSON-as-text / form-urlencoded / value-pattern |

### Plugins

Detection plugins (unchanged from v1):

- **sensitive-keys** — key-level substring matching
- **jwt** — JWT token detection
- **bearer** — Bearer token detection
- **awsKeys** — AWS access key ID
- **githubTokens** — GitHub PAT tokens
- **email** — Email address detection
- **ipAddress** — IPv4 address detection
- **creditCard** — Credit card number detection
- **hexKeys** — Hex key detection (32+ chars)

## Plugin Integration

Plugins declare their own redaction scopes via `PluginFactory.redaction`:

```ts
// gRPC plugin
grpc({
  proto: "./protos/users.proto",
  address: "{{ADDR}}",
  package: "acme.users.v1",
  service: "UsersService",
});

// Plugin internally declares:
// redaction: [
//   { id: "grpc.metadata", handler: "headers", rules: { sensitiveKeys: ["authorization"] } },
//   { id: "grpc.request",  handler: "json" },
//   { id: "grpc.response", handler: "json" },
// ]
```

The runner collects all plugin declarations and merges them with built-in scopes at compile time.

## User Overrides

Users override scopes by stable `id` in `.glubean/redact.json`:

```json
{
  "scopes": {
    "grpc.metadata": { "enabled": false },
    "http.request.headers": {
      "rules": { "sensitiveKeys": ["x-custom-secret"] }
    }
  },
  "globalRules": {
    "sensitiveKeys": ["my-internal-key"],
    "customPatterns": [
      { "name": "internal-id", "regex": "INT-[A-Z0-9]{8}" }
    ]
  }
}
```

## Replacement Formats

| Format | Example |
|--------|---------|
| `simple` | `[REDACTED]` |
| `labeled` | `[REDACTED:sensitive-keys]` |
| `partial` | `Bea***123` (smart masking) |

## License

[Apache-2.0](./LICENSE)
