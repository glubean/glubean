# Architecture Overview

Glubean OSS is a Deno-based monorepo. All packages are published to [JSR](https://jsr.io) under the `@glubean` scope.

## Package Map

```
glubean/
└── packages/
    ├── sdk/        # Test authoring API (end-user facing)
    ├── scanner/    # Test discovery and metadata extraction
    ├── runner/     # Test execution engine
    ├── worker/     # Self-hosted worker agent
    ├── cli/        # Command-line interface
    ├── mcp/        # AI IDE integration (MCP server)
    └── redaction/  # Secret redaction utilities
```

## Packages

### `@glubean/sdk` — Test Authoring

The API for writing API tests. Stays thin and stable.

```typescript
import { test } from "@glubean/sdk";

export const login = test("login", async (ctx) => {
  const res = await fetch(ctx.vars.require("BASE_URL") + "/login");
  ctx.assert(res.ok, "Login should succeed");
});
```

**Key exports:** `test()`, `configure()`, `TestContext`, data loaders (`fromCsv`, `fromYaml`, `fromDir`)

### `@glubean/scanner` — Test Discovery

Discovers and extracts metadata from test files.

- **Static analysis** — regex-based, no code execution (safe for untrusted code)
- **Runtime extraction** — dynamic import, full metadata (requires trust)

**Used by:** CLI, MCP server

### `@glubean/runner` — Test Execution

Executes tests in a sandboxed subprocess.

- Subprocess isolation via `Deno.Command`
- JSON event streaming on stdout
- Timeout enforcement
- Parallel test execution

**Used by:** CLI (local runs), Worker (remote runs)

### `@glubean/worker` — Self-hosted Worker

Long-running agent that claims and executes tasks from a control plane.

- Pull-based task claiming (outbound-only connectivity)
- Tag-based routing
- Concurrent task execution
- Memory monitoring and graceful shutdown

### `@glubean/cli` — Command Line Interface

Local test execution and project management.

```bash
glubean run ./tests --filter smoke    # Run tests
glubean init                          # Initialize project
glubean scan                          # Generate metadata
```

### `@glubean/mcp` — AI IDE Integration

MCP server for AI-assisted test development in Cursor and other AI IDEs.

**Tools:** `glubean_discover_tests`, `glubean_run_local_file`, `glubean_list_test_files`, `glubean_get_metadata`

### `@glubean/redaction` — Secret Redaction

Utilities for redacting sensitive values from logs and event streams.

## Component Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Code                                │
│                    (uses @glubean/sdk)                          │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Discovery Layer                             │
│                                                                 │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│   │   Scanner   │    │    CLI      │    │    MCP      │        │
│   │  (indexing) │    │  (local)    │    │  (AI IDE)   │        │
│   └─────────────┘    └─────────────┘    └─────────────┘        │
│          │                  │                  │                │
└──────────┼──────────────────┼──────────────────┼────────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Execution Layer                             │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                    @glubean/runner                       │  │
│   │              (subprocess isolation)                      │  │
│   └─────────────────────────────────────────────────────────┘  │
│                              │                                  │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Deployment Layer                            │
│                                                                 │
│   ┌─────────────┐                         ┌─────────────┐      │
│   │  Local CLI  │                         │   Worker    │      │
│   │  (dev use)  │                         │  (self-     │      │
│   │             │                         │   hosted)   │      │
│   └─────────────┘                         └─────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

**Local execution:**

```
User → CLI → Scanner → Runner → Harness (subprocess) → stdout JSON → CLI → Terminal
```

**AI IDE integration:**

```
AI Agent → MCP Server → Scanner/Runner → Structured Results → AI Agent → Code Fix
```

## Metadata Schema

When `glubean scan` runs, it produces `metadata.json` — an index of all tests:

```json
{
  "schemaVersion": "1",
  "specVersion": "2.0",
  "generatedBy": "@glubean/cli@0.10.0",
  "generatedAt": "2026-02-04T12:00:00Z",
  "rootHash": "sha256-...",
  "testCount": 3,
  "fileCount": 2,
  "tags": ["auth", "smoke"],
  "files": {
    "auth/login.ts": {
      "hash": "sha256-...",
      "exports": [
        {
          "type": "testCase",
          "exportName": "loginTest",
          "id": "login-test",
          "name": "Login Test",
          "tags": ["smoke"],
          "location": { "line": 10, "col": 1 }
        }
      ]
    }
  }
}
```

`rootHash` is computed from sorted `<path>:<hash>` entries joined by `\n`.

## Security Model

| Component         | Trust Level  | Isolation                     |
| ----------------- | ------------ | ----------------------------- |
| SDK               | User code    | N/A (library)                 |
| Scanner (static)  | Untrusted    | No execution                  |
| Scanner (runtime) | Trusted      | Import-based                  |
| Runner            | Untrusted    | Subprocess + Deno permissions |
| Worker            | Trusted      | Task-scoped tokens            |
| CLI               | User machine | Local execution               |
| MCP               | User machine | Local execution               |

## Plugin System (designed)

The SDK is being extended with a plugin architecture that enables third-party extensibility
without growing the core kernel. See [Plugin System Design](./plugin-system.md) for the full design.

### Extension hooks (6 SDK-side)

| Hook | Purpose | Phase |
| ---- | ------- | ----- |
| Data Loaders | Custom data sources (`fromGraphQL`, `fromProtobuf`, etc.) | 1 |
| Configure Plugins | Register plugins via `configure()` | 1 |
| Context Extension | `test.extend()` for custom fixtures (Playwright-inspired) | 3 |
| HTTP Middleware | Request/response interceptors on `ctx.http` | 2 |
| Custom Assertion Matchers | `Expectation.extend()` for domain-specific assertions | 2 |
| Event Reporters | Custom event sinks (`ctx.emit()`) | 2 |

### Planned SDK restructuring

As the plugin system matures, the SDK will evolve toward a **core kernel + extracted plugins**
model. Built-in capabilities (like `ctx.http`, data loaders) will be refactored into first-party
plugins that use the same extension API as community plugins. This keeps the kernel minimal
while demonstrating that the plugin API is sufficient for real workloads.

### Cloud-side visualization

Plugin-generated events (`plugin:*` types) need rendering in the Cloud dashboard. Two solution
candidates are documented in the plugin system design: structured render hints (data-driven)
and a community renderer repository (React components reviewed and merged by the Glubean team).

## Version Compatibility

All packages follow semver. The runner event schema is the compatibility contract — see
[Event Reference](../reference/events.md).
