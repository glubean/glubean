# Glubean OSS Components

This document provides an overview of all packages in the Glubean OSS monorepo and their relationships.

## Package Overview

```
glubean/oss/
├── packages/
│   ├── sdk/        # Test authoring SDK (end-user facing)
│   ├── scanner/    # Test discovery and metadata extraction
│   ├── runner/     # Test execution engine
│   ├── worker/     # Self-hosted worker agent
│   ├── cli/        # Command-line interface
│   └── mcp/        # AI IDE integration (MCP server)
└── examples/       # Example test projects
```

## Component Responsibilities

### `@glubean/sdk` - Test Authoring

**Purpose:** Provides the API for writing API tests.

**Exports:**
- `testCase()` - Define a single test
- `testSuite()` - Group related tests
- `TestContext` - Runtime context (vars, secrets, log, etc.)

**Used by:** End users writing tests

```typescript
import { testCase } from "@glubean/sdk";

export const myTest = testCase({ id: "login" }, async (ctx) => {
  const res = await fetch(ctx.vars.API_URL);
  ctx.assert(res.ok, "API should respond");
});
```

---

### `@glubean/scanner` - Test Discovery

**Purpose:** Discovers and extracts metadata from test files.

**Modes:**
- **Static analysis** - Regex-based, no code execution (safe for untrusted code)
- **Runtime extraction** - Dynamic import, full metadata (requires trust)

**Used by:** CLI, MCP, Server (bundle indexing)

```typescript
import { createStaticScanner } from "@glubean/scanner";

const scanner = createStaticScanner();
const result = await scanner.scan("./tests");
// { files: [...], version: 1 }
```

---

### `@glubean/runner` - Test Execution

**Purpose:** Executes tests in a sandboxed subprocess.

**Features:**
- Subprocess isolation via `Deno.Command`
- JSON event streaming (stdout)
- Timeout enforcement
- Parallel test execution within a task

**Used by:** CLI (local runs), Worker (cloud/self-hosted runs)

```typescript
import { TestExecutor } from "@glubean/runner";

const executor = new TestExecutor();
const result = await executor.execute(testUrl, testId, context);
```

---

### `@glubean/worker` - Self-hosted Worker

**Purpose:** Long-running agent that claims and executes tasks from ControlPlane.

**Features:**
- Pull-based task claiming (outbound-only connectivity)
- Tag-based routing (tier:free, tier:pro, team:xxx)
- Concurrent task execution (configurable)
- Memory monitoring
- Event streaming to ControlPlane
- Graceful shutdown

**Used by:** Self-hosted deployments, Glubean Cloud infrastructure

```bash
# Environment-based config
export GLUBEAN_CONTROL_PLANE_URL=https://api.glubean.com
export GLUBEAN_WORKER_TOKEN=gwt_xxx
export GLUBEAN_WORKER_TAGS=tier:pro,team:acme
export GLUBEAN_MAX_CONCURRENT_TASKS=5

deno run -A jsr:@glubean/worker/cli
```

---

### `@glubean/cli` - Command Line Interface

**Purpose:** Local test execution and project management.

**Commands:**
- `glubean run <file|dir>` - Run tests locally
- `glubean sync` - Sync tests to cloud
- `glubean init` - Initialize a project

**Used by:** Developers during development

```bash
glubean run ./tests --filter="login" --tags="smoke"
```

---

### `@glubean/mcp` - AI IDE Integration

**Purpose:** MCP server for AI-assisted test development.

**Tools:**
- `glubean_discover_tests` - List tests in a file
- `glubean_run_local_file` - Execute tests locally
- `glubean_open_trigger_run` - Trigger cloud run (requires token)
- `glubean_open_get_run` - Get run results

**Used by:** AI IDEs (Cursor, etc.) for closed-loop development

```bash
# Start MCP server
deno run -A ./packages/mcp/mod.ts
```

---

## Component Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Code                                │
│                    (uses @glubean/sdk)                          │
└─────────────────────────────────────────────────────────────────┘
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
│   │  (dev use)  │                         │  (cloud/    │      │
│   │             │                         │  self-host) │      │
│   └─────────────┘                         └─────────────┘      │
│                                                  │              │
│                                                  ▼              │
│                                           ControlPlane          │
│                                           (glubean-v1)          │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Local Execution (CLI)

```
User → CLI → Scanner → Runner → Harness (subprocess) → stdout JSON → CLI → Terminal
```

### Cloud/Self-hosted Execution (Worker)

```
ControlPlane → Worker (claim) → Download Bundle → Runner → Harness → Events → ControlPlane
```

### AI IDE Integration (MCP)

```
AI Agent → MCP Server → Scanner/Runner → Structured Results → AI Agent → Code Fix
```

## Security Model

| Component | Trust Level | Isolation |
|-----------|-------------|-----------|
| SDK | User code | N/A (library) |
| Scanner (static) | Untrusted | No execution |
| Scanner (runtime) | Trusted | Import-based |
| Runner | Untrusted | Subprocess + Deno permissions |
| Worker | Trusted | Task-scoped tokens |
| CLI | User machine | Local execution |
| MCP | User machine | Local execution |

## Version Compatibility

All packages follow semver. The `@glubean/runner` event schema is the compatibility contract:

- `ExecutionEvent` types must remain backward-compatible
- `TimelineEvent` is the internal representation
- `RunEvent` is the ControlPlane contract (separate repo)
