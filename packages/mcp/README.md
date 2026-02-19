# Glubean MCP server (Cursor / AI agent loop)

> **Early-stage / experimental** — This package is under active development and not yet intended for direct external
> consumption. APIs may change without notice. Full documentation will be added once the interface stabilises.

This package provides a **Model Context Protocol (MCP)** server that enables an AI agent to:

- discover Glubean `test` exports in a file
- run them locally and return **structured failures**
- trigger and fetch remote runs via Glubean **Open Platform API**

This is the “closed loop” that enables:

> AI writes checks → runs → sees facts → fixes → reruns (you review the diff).

## Run locally (stdio)

From repo root:

```bash
deno run -A ./packages/mcp/mod.ts
```

Notes:

- This is a **stdio** MCP server. It must not write to stdout except MCP JSON-RPC.
- The server uses stderr for logs.
- Local execution uses the Glubean runner, which spawns a Deno subprocess. You need `-A` (or at least
  `--allow-run --allow-read --allow-net`).

## Tools

- `glubean_discover_tests`
- `glubean_run_local_file`
- `glubean_get_last_run_summary`
- `glubean_get_local_events`
- `glubean_list_test_files`
- `glubean_diagnose_config`
- `glubean_get_metadata`
- `glubean_open_trigger_run`
- `glubean_open_get_run`
- `glubean_open_get_run_events`

### Local debugging helpers

- `glubean_get_last_run_summary`: Returns summary metadata for the most recent `glubean_run_local_file` call.
- `glubean_get_local_events`: Returns flattened local events (`result`, `assertion`, `log`, `trace`) with optional
  filtering.
- `glubean_diagnose_config`: Checks project config health (`deno.json`, `.env`, `.env.secrets`, `tests/`, `explore/`)
  and returns actionable recommendations.

## Security notes

- The MCP server never returns `.env.secrets` values.
- Remote run tools require a **project token** (Open Platform) with least-privilege scopes.
