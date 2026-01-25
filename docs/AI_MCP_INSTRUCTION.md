# AI Instruction: Glubean MCP (Cursor closed loop)

This document explains how to use the Glubean MCP server to enable the “closed loop”:

> AI writes checks → runs → reads structured failures → fixes → reruns.

## Why MCP matters for Glubean

AI can generate test-as-code cheaply.
Glubean’s defensible value is the **execution + facts** layer:

- run locally/CI with consistent semantics
- fetch structured failures (assertions/logs/traces)
- optionally trigger/tail remote runs via Open Platform APIs

MCP gives AI agents a safe, explicit interface to do this without DIY glue.

## Start the MCP server

From this repo root:

```bash
deno run -A ./packages/mcp/mod.ts
```

## Configure Cursor (example)

Add an MCP server entry that runs the command above.
Exact location and format depends on your MCP host/client.

For a generic stdio MCP host, the command/args are:

- command: `deno`
- args:
  - `run`
  - `-A`
  - `/ABSOLUTE/PATH/TO/glubean/oss/packages/mcp/mod.ts`

## Tool usage guidance (for AI agents)

### Local workflow (recommended default)

1. `glubean_discover_tests` to list tests in a file.
2. `glubean_run_local_file` to execute (optionally filtered) and capture structured failures.
3. Modify code and rerun until green.

### Remote workflow (optional)

If you have a project token:

1. `glubean_open_trigger_run` to create a run.
2. `glubean_open_get_run` and `glubean_open_get_run_events` to poll and diagnose failures.

## Safety rules

- Never request or return plaintext secrets.
- Prefer project-scoped tokens with minimal scopes (`runs:read`, `runs:write`, etc.).
- Treat logs and traces as potentially sensitive and rely on platform-side redaction boundaries.

