# AI Agent Integration (MCP)

The Glubean MCP server enables AI agents (Cursor, Copilot, etc.) to discover, run, and debug API tests in a closed loop:

```
AI writes test → runs locally → sees failure → fixes code → reruns → ✓ pass
```

## Setup

### 1. Install Glubean CLI

```bash
deno install -A -n glubean jsr:@glubean/cli
```

### 2. Configure MCP in Cursor

Add to `~/.cursor/mcp.json` (or via Cursor Settings > MCP):

```json
{
  "mcpServers": {
    "glubean": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@glubean/mcp"]
    }
  }
}
```

For local development of the MCP server itself:

```json
{
  "mcpServers": {
    "glubean": {
      "command": "deno",
      "args": ["run", "-A", "/path/to/glubean/packages/mcp/mod.ts"]
    }
  }
}
```

### 3. Restart Cursor

Close and reopen Cursor to load the MCP configuration.

---

## Workflow: Write, Run, Fix

### User Prompt

```
Write tests for the /users API endpoint, then run them and fix any failures.
```

### What the AI Does

**1. Creates test file** (`users.test.ts`)

**2. Discovers tests** via MCP:

```json
{ "tool": "glubean_discover_tests", "input": { "filePath": "users.test.ts" } }
```

Returns test IDs, names, and tags.

**3. Runs tests locally** via MCP:

```json
{
  "tool": "glubean_run_local_file",
  "input": { "filePath": "users.test.ts", "includeLogs": true }
}
```

Returns structured results with assertions, logs, and traces.

**4. Analyzes failures** — e.g., `expected: 1, actual: "1"` (type mismatch)

**5. Fixes the test** and reruns until all pass.

---

## MCP Tool Reference

### `glubean_discover_tests`

List all test exports in a file.

**Input:**

```json
{ "filePath": "tests/api.test.ts" }
```

**Output:**

```json
{
  "tests": [
    {
      "exportName": "listUsers",
      "id": "list-users",
      "name": "List All Users",
      "tags": ["users", "smoke"]
    }
  ]
}
```

### `glubean_run_local_file`

Run tests locally and return structured results.

**Input:**

```json
{
  "filePath": "tests/api.test.ts",
  "filter": "smoke",
  "envFile": ".env",
  "includeLogs": true,
  "includeTraces": false,
  "stopOnFailure": false,
  "concurrency": 1
}
```

**Output:**

```json
{
  "projectRoot": "/path/to/project",
  "varsCount": 2,
  "secretsCount": 1,
  "summary": { "total": 3, "passed": 2, "failed": 1 },
  "results": [
    {
      "exportName": "myTest",
      "id": "my-test",
      "name": "My Test",
      "success": false,
      "durationMs": 123,
      "assertions": [
        {
          "passed": false,
          "message": "Should return 200",
          "expected": 200,
          "actual": 404
        }
      ],
      "logs": [{ "message": "Fetching data..." }],
      "error": { "message": "Assertion failed" }
    }
  ]
}
```

Secrets values are never returned — only the count.

### `glubean_get_last_run_summary`

Return a compact summary for the most recent `glubean_run_local_file` execution. Useful for quick status checks before
requesting detailed events.

**Input:**

```json
{}
```

**Output (example):**

```json
{
  "createdAt": "2026-02-19T00:00:00.000Z",
  "summary": { "total": 3, "passed": 2, "failed": 1 },
  "eventCounts": { "result": 3, "assertion": 12, "log": 4, "trace": 1 }
}
```

### `glubean_get_local_events`

Return flattened local-run events from the most recent run snapshot.

**Input:**

```json
{ "type": "assertion", "testId": "my-test", "limit": 100 }
```

**Output (example):**

```json
{
  "events": [
    {
      "type": "assertion",
      "testId": "my-test",
      "message": "Should return 200",
      "passed": false,
      "expected": 200,
      "actual": 404
    }
  ],
  "count": 1
}
```

### `glubean_list_test_files`

List test files in the project without executing them.

**Input:**

```json
{ "dir": ".", "mode": "static" }
```

**Output:**

```json
{
  "rootDir": "/path/to/project",
  "fileCount": 2,
  "files": ["api.test.ts", "tests/auth.test.ts"]
}
```

### `glubean_diagnose_config`

Diagnose local project configuration without running tests.

**Input:**

```json
{ "dir": "." }
```

**Output (example):**

```json
{
  "projectRoot": "/path/to/project",
  "denoJson": { "exists": true },
  "envFile": { "exists": false, "hasBaseUrl": false },
  "testsDir": { "exists": false },
  "exploreDir": { "exists": true },
  "recommendations": ["Missing \".env\" file (expected BASE_URL)."]
}
```

### `glubean_get_metadata`

Generate metadata in-memory (equivalent to `glubean scan`) without writing to disk.

**Input:**

```json
{ "dir": ".", "mode": "runtime" }
```

**Output:**

```json
{
  "metadata": {
    "specVersion": "2.0",
    "fileCount": 2,
    "testCount": 6,
    "tags": ["auth", "smoke"],
    "files": { "api.test.ts": { "hash": "sha256-...", "exports": [] } }
  }
}
```

---

## Best Practices for AI Agents

1. **Always run locally first** — catch obvious issues before involving the user.
2. **Use structured failures** — parse assertion `expected`/`actual` values, don't just read error strings.
3. **Iterate incrementally** — fix one failure, rerun, repeat.
4. **Check `.env` exists** — if tests fail with "Required var not found", the env file may be missing.

---

## Troubleshooting

### MCP Server Not Found

Add to `~/.cursor/mcp.json` and restart Cursor:

```json
{
  "mcpServers": {
    "glubean": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@glubean/mcp"]
    }
  }
}
```

### Missing Vars

If tests fail with `"Required var 'BASE_URL' not found"`, ensure `.env` exists in the project root with the required
variables.
