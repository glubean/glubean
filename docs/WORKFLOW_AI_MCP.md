# Workflow: AI Agent / MCP (Cursor)

This document describes how AI agents (like Cursor AI) use the Glubean MCP (Model Context Protocol) server to automatically write, run, debug, and fix API tests.

---

## Overview

The **Glubean MCP server** enables the AI agent to:

1. **Discover tests** in a file (list all `testCase` exports)
2. **Run tests locally** and get structured failures (assertions, logs, traces)
3. **List test files / metadata** for repo-level context (optional)
4. **Trigger remote runs** and fetch results from Glubean Cloud
5. **Fix failures automatically** by analyzing structured output

This creates a **closed loop**:

```
AI writes test → runs locally → sees failure → fixes code → reruns → ✓ pass
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Cursor IDE (AI Agent)                                            │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ User: "Write tests for /users API and run them"            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│                           │                                       │
│                           ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ MCP Client (built into Cursor)                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           │                                       │
└───────────────────────────┼───────────────────────────────────────┘
                            │ stdio (JSON-RPC)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Glubean MCP Server (Deno process)                                │
│                                                                   │
│  Tools:                                                           │
│  • glubean_discover_tests      ← List tests in file              │
│  • glubean_run_local_file      ← Run tests, get structured output│
│  • glubean_list_test_files     ← Lightweight repo index          │
│  • glubean_get_metadata        ← In-memory metadata.json         │
│  • glubean_open_trigger_run    ← Trigger remote run              │
│  • glubean_open_get_run        ← Get run status                  │
│  • glubean_open_get_run_events ← Fetch run events (paginated)    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
            │                            │
            ▼                            ▼
   ┌─────────────────┐        ┌──────────────────────┐
   │ Local Execution │        │ Glubean Cloud APIs   │
   │ (TestExecutor)  │        │ (Open Platform)      │
   └─────────────────┘        └──────────────────────┘
```

---

## Setup: Configure MCP in Cursor

### 1. Install Glubean CLI

```bash
deno install -A -n glubean jsr:@glubean/cli
```

### 2. Configure MCP Server

Add to Cursor's MCP settings (`~/.cursor/mcp.json` or via UI):

```json
{
  "mcpServers": {
    "glubean": {
      "command": "deno",
      "args": ["run", "-A", "jsr:@glubean/mcp"],
      "description": "Glubean test runner and cloud integration"
    }
  }
}
```

**Or use local development version:**

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

### 3. Set Environment Variables

The MCP server reads credentials from environment:

```bash
# Add to ~/.zshrc or ~/.bashrc
export GLUBEAN_TOKEN=glb_token_xxxxxxxxxxxxxxxx
export GLUBEAN_API_URL=https://api.glubean.com
```

Or create `~/.glubean/config`:

```json
{
  "token": "glb_token_xxxxxxxxxxxxxxxx",
  "apiUrl": "https://api.glubean.com"
}
```

### 4. Restart Cursor

Close and reopen Cursor to load the MCP configuration.

---

## Workflow 1: AI Writes and Validates Tests Locally

### User Prompt

```
Write tests for the /users API endpoint. The API should:
- List all users (GET /users)
- Get user by ID (GET /users/:id)
- Create user (POST /users)

Then run the tests and fix any failures.
```

### AI Agent Actions

#### Step 1: Create Test File

AI creates `users.test.ts`:

```typescript
import { test } from "@glubean/sdk";

export const listUsers = test(
  {
    id: "list-users",
    name: "List All Users",
    tags: ["users", "smoke"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const response = await fetch(`${baseUrl}/users`);
    const users = await response.json();

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(Array.isArray(users), "Should return array");
    ctx.assert(users.length > 0, "Should have users");
  }
);

export const getUserById = test(
  {
    id: "get-user",
    name: "Get User by ID",
    tags: ["users"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const response = await fetch(`${baseUrl}/users/1`);
    const user = await response.json();

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(user.id === 1, "User ID should be 1");
    ctx.assert(!!user.name, "User should have name");
  }
);
```

#### Step 2: Discover Tests

**AI calls MCP tool:**

```json
{
  "tool": "glubean_discover_tests",
  "input": {
    "filePath": "users.test.ts"
  }
}
```

**MCP returns:**

```json
{
  "tests": [
    {
      "exportName": "listUsers",
      "id": "list-users",
      "name": "List All Users",
      "tags": ["users", "smoke"],
      "only": false,
      "skip": false
    },
    {
      "exportName": "getUserById",
      "id": "get-user",
      "name": "Get User by ID",
      "tags": ["users"],
      "only": false,
      "skip": false
    }
  ]
}
```

#### Step 3: Run Tests Locally

**AI calls MCP tool:**

```json
{
  "tool": "glubean_run_local_file",
  "input": {
    "filePath": "users.test.ts",
    "includeLogs": true,
    "includeTraces": false,
    "concurrency": 1
  }
}
```

**MCP returns (if test fails):**

```json
{
  "projectRoot": "/Users/dev/myproject",
  "fileUrl": "file:///Users/dev/myproject/users.test.ts",
  "varsCount": 1,
  "secretsCount": 0,
  "summary": {
    "total": 2,
    "passed": 1,
    "failed": 1
  },
  "results": [
    {
      "exportName": "listUsers",
      "id": "list-users",
      "name": "List All Users",
      "success": true,
      "durationMs": 234,
      "assertions": [
        {
          "passed": true,
          "message": "Should return 200",
          "expected": 200,
          "actual": 200
        },
        {
          "passed": true,
          "message": "Should return array"
        },
        {
          "passed": true,
          "message": "Should have users"
        }
      ],
      "logs": [{ "message": "Fetching all users..." }],
      "traces": []
    },
    {
      "exportName": "getUserById",
      "id": "get-user",
      "name": "Get User by ID",
      "success": false,
      "durationMs": 123,
      "assertions": [
        {
          "passed": true,
          "message": "Should return 200"
        },
        {
          "passed": false,
          "message": "User ID should be 1",
          "expected": 1,
          "actual": "1"
        }
      ],
      "logs": [],
      "traces": [],
      "error": {
        "message": "Assertion failed: User ID should be 1"
      }
    }
  ]
}
```

#### Step 4: AI Analyzes Failure

AI sees:

- **Assertion failed**: `"User ID should be 1"`
- **Expected**: `1` (number)
- **Actual**: `"1"` (string)

**Root cause**: API returns string ID, test expects number.

#### Step 5: AI Fixes Test

AI updates `users.test.ts`:

```typescript
export const getUserById = test(
  {
    id: "get-user",
    name: "Get User by ID",
    tags: ["users"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const response = await fetch(`${baseUrl}/users/1`);
    const user = await response.json();

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(user.id === "1", "User ID should be '1'"); // Fixed: string comparison
    ctx.assert(!!user.name, "User should have name");
  }
);
```

#### Step 6: Rerun Tests

AI calls `glubean_run_local_file` again.

**MCP returns:**

```json
{
  "summary": {
    "total": 2,
    "passed": 2,
    "failed": 0
  },
  "results": [
    {
      "exportName": "listUsers",
      "success": true,
      "durationMs": 234
    },
    {
      "exportName": "getUserById",
      "success": true,
      "durationMs": 123
    }
  ]
}
```

✅ **All tests pass!**

AI reports to user:

> "I've created tests for the /users API and verified they all pass. The API returns user IDs as strings, so I've updated the assertions accordingly."

---

## Workflow 2: AI Triggers Remote Run and Monitors

### User Prompt

```
Sync my tests to Glubean and trigger a remote run. Show me the results.
```

### AI Agent Actions

#### Step 1: User Syncs to Cloud

(AI guides user to run):

```bash
glubean sync --project prj_abc123
```

Result:

- **Bundle ID**: `bun_xyz789`
- **Version**: `2026-02-04-12-30-45`

#### Step 2: AI Triggers Remote Run

**AI calls MCP tool:**

```json
{
  "tool": "glubean_open_trigger_run",
  "input": {
    "apiUrl": "https://api.glubean.com",
    "token": "$GLUBEAN_TOKEN",
    "projectId": "prj_abc123",
    "bundleId": "bun_xyz789"
  }
}
```

**MCP returns:**

```json
{
  "runId": "run_123456",
  "taskId": "tsk_789012",
  "bundleId": "bun_xyz789"
}
```

AI informs user:

> "Remote run triggered. Run ID: `run_123456`. View at: https://app.glubean.com/runs/run_123456"

#### Step 3: Poll Run Status

**AI calls MCP tool (repeatedly until terminal status):**

```json
{
  "tool": "glubean_open_get_run",
  "input": {
    "apiUrl": "https://api.glubean.com",
    "token": "$GLUBEAN_TOKEN",
    "runId": "run_123456"
  }
}
```

**MCP returns (while running):**

```json
{
  "runId": "run_123456",
  "status": "running",
  "projectId": "prj_abc123",
  "bundleId": "bun_xyz789"
}
```

AI waits 2-3 seconds, polls again...

**MCP returns (completed):**

```json
{
  "runId": "run_123456",
  "status": "passed",
  "projectId": "prj_abc123",
  "bundleId": "bun_xyz789",
  "summary": {
    "total": 5,
    "passed": 5,
    "failed": 0,
    "skipped": 0,
    "durationMs": 1234
  }
}
```

#### Step 4: Fetch Run Events (Optional)

To show detailed logs:

**AI calls MCP tool:**

```json
{
  "tool": "glubean_open_get_run_events",
  "input": {
    "apiUrl": "https://api.glubean.com",
    "token": "$GLUBEAN_TOKEN",
    "runId": "run_123456",
    "limit": 100
  }
}
```

**MCP returns:**

```json
{
  "events": [
    {
      "seq": 1,
      "type": "log",
      "timestamp": "2026-02-04T12:31:00.123Z",
      "message": "Fetching all users..."
    },
    {
      "seq": 2,
      "type": "assertion",
      "timestamp": "2026-02-04T12:31:00.456Z",
      "message": "Should return 200",
      "passed": true,
      "expected": 200,
      "actual": 200
    },
    {
      "seq": 3,
      "type": "log",
      "timestamp": "2026-02-04T12:31:00.789Z",
      "message": "Found 10 users"
    }
  ],
  "nextCursor": 101,
  "hasMore": true
}
```

If `hasMore: true`, AI can fetch next page:

```json
{
  "tool": "glubean_open_get_run_events",
  "input": {
    "runId": "run_123456",
    "afterSeq": 101,
    "limit": 100
  }
}
```

#### Step 5: AI Reports Results

AI tells user:

> "✅ Remote run completed successfully!
>
> - **Status**: PASSED
> - **Tests**: 5 passed, 0 failed
> - **Duration**: 1234ms
> - **View**: https://app.glubean.com/runs/run_123456"

---

## Workflow 3: AI Debugs Remote Failures

### User Prompt

```
My remote run failed. Can you investigate and fix it?
```

### AI Agent Actions

#### Step 1: Get Run Status

AI knows the run ID from context (or asks user).

**AI calls:**

```json
{
  "tool": "glubean_open_get_run",
  "input": {
    "runId": "run_failed_123"
  }
}
```

**MCP returns:**

```json
{
  "runId": "run_failed_123",
  "status": "failed",
  "summary": {
    "total": 5,
    "passed": 3,
    "failed": 2,
    "skipped": 0
  }
}
```

#### Step 2: Fetch Failed Test Events

**AI calls:**

```json
{
  "tool": "glubean_open_get_run_events",
  "input": {
    "runId": "run_failed_123",
    "type": "assertion",
    "limit": 1000
  }
}
```

**MCP returns:**

```json
{
  "events": [
    {
      "seq": 15,
      "type": "assertion",
      "message": "Should return 200",
      "passed": false,
      "expected": 200,
      "actual": 401
    },
    {
      "seq": 16,
      "type": "error",
      "message": "Unauthorized"
    }
  ]
}
```

#### Step 3: AI Analyzes Root Cause

AI sees:

- **Expected**: `200`
- **Actual**: `401 Unauthorized`

**Root cause**: Missing or invalid authentication in remote environment.

#### Step 4: AI Suggests Fix

AI tells user:

> "The remote run failed because the API returned `401 Unauthorized`. This suggests the `API_KEY` secret is missing or invalid in your Glubean environment group.
>
> **To fix:**
>
> 1. Go to Dashboard → Project → Environment Groups
> 2. Select the environment used for this run
> 3. Add/update the secret: `API_KEY=sk_live_xxxxxxx`
> 4. Trigger a new run
>
> Would you like me to show you how to do this?"

---

## Advanced: AI Auto-Fixes and Validates

### Scenario: API Contract Changed

**User prompt:**

```
The API changed. Fix the tests and verify they pass remotely.
```

### AI Actions

1. **Fetch latest run events** (to see what broke)
2. **Analyze failures** (e.g., new required field)
3. **Update test file** (add new assertions)
4. **Run locally** (verify fix works)
5. **Guide user to sync** (`glubean sync`)
6. **Trigger remote run** (verify in cloud)
7. **Report success**

---

## MCP Tool Reference

### `glubean_discover_tests`

**Purpose**: List all `testCase` exports in a file.

**Input:**

```json
{
  "filePath": "tests/api.test.ts"
}
```

**Output:**

```json
{
  "tests": [
    {
      "exportName": "myTest",
      "id": "my-test",
      "name": "My Test",
      "tags": ["smoke"],
      "only": false,
      "skip": false
    }
  ]
}
```

---

### `glubean_run_local_file`

**Purpose**: Run tests locally and return structured results.

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
  "fileUrl": "file:///path/to/project/tests/api.test.ts",
  "varsCount": 2,
  "secretsCount": 1,
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1
  },
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
      "traces": [],
      "error": {
        "message": "Assertion failed",
        "stack": "..."
      }
    }
  ]
}
```

**Note**: `secrets` values are never returned (only count).

---

### `glubean_list_test_files`

**Purpose**: Return a lightweight list of test files in the project (no file writes).

**Input:**

```json
{
  "dir": ".",
  "mode": "static"
}
```

**Output:**

```json
{
  "rootDir": "/path/to/project",
  "mode": "static",
  "fileCount": 2,
  "files": ["api.test.ts", "tests/auth.test.ts"],
  "warnings": []
}
```

---

### `glubean_get_metadata`

**Purpose**: Generate metadata (equivalent to `metadata.json`) in-memory for AI use, without writing to disk.

**Input:**

```json
{
  "dir": ".",
  "mode": "runtime"
}
```

**Output:**

```json
{
  "rootDir": "/path/to/project",
  "mode": "runtime",
  "metadata": {
    "schemaVersion": "1",
    "specVersion": "2.0",
    "generatedBy": "@glubean/mcp@0.1.0",
    "generatedAt": "2026-02-04T18:00:00.000Z",
    "rootHash": "sha256-...",
    "fileCount": 2,
    "testCount": 6,
    "tags": ["auth", "smoke"],
    "files": {
      "api.test.ts": { "hash": "sha256-...", "exports": [] }
    },
    "warnings": []
  }
}
```

---

### `glubean_open_trigger_run`

**Purpose**: Trigger a remote run via Open Platform API.

**Input:**

```json
{
  "apiUrl": "https://api.glubean.com",
  "token": "glb_token_xxxxxxxx",
  "projectId": "prj_abc123",
  "bundleId": "bun_xyz789",
  "jobId": "job_optional"
}
```

**Output:**

```json
{
  "runId": "run_123456",
  "taskId": "tsk_789012",
  "bundleId": "bun_xyz789"
}
```

---

### `glubean_open_get_run`

**Purpose**: Get run status.

**Input:**

```json
{
  "apiUrl": "https://api.glubean.com",
  "token": "glb_token_xxxxxxxx",
  "runId": "run_123456"
}
```

**Output:**

```json
{
  "runId": "run_123456",
  "status": "passed",
  "projectId": "prj_abc123",
  "bundleId": "bun_xyz789",
  "summary": {
    "total": 5,
    "passed": 5,
    "failed": 0,
    "skipped": 0,
    "durationMs": 1234
  }
}
```

**Status values**: `pending`, `running`, `passed`, `failed`, `cancelled`, `exhausted`

---

### `glubean_open_get_run_events`

**Purpose**: Fetch run events (logs, assertions, traces).

**Input:**

```json
{
  "apiUrl": "https://api.glubean.com",
  "token": "glb_token_xxxxxxxx",
  "runId": "run_123456",
  "afterSeq": 0,
  "limit": 100,
  "type": "assertion"
}
```

**Output:**

```json
{
  "events": [
    {
      "seq": 1,
      "type": "log",
      "timestamp": "2026-02-04T12:31:00.123Z",
      "message": "Fetching users..."
    },
    {
      "seq": 2,
      "type": "assertion",
      "timestamp": "2026-02-04T12:31:00.456Z",
      "message": "Should return 200",
      "passed": true,
      "expected": 200,
      "actual": 200
    }
  ],
  "nextCursor": 101,
  "hasMore": true
}
```

**Event types**: `log`, `assertion`, `trace`, `error`, `step_start`, `step_end`, `status`

---

## Best Practices for AI Agents

### 1. Always Run Locally First

Before triggering remote runs, run tests locally to catch obvious issues.

```
1. Create test
2. Run locally (glubean_run_local_file)
3. Fix failures
4. Sync to cloud (user runs glubean sync)
5. Trigger remote run
```

### 2. Use Structured Failures

When tests fail, analyze:

- **Assertions**: `passed`, `expected`, `actual`
- **Logs**: `ctx.log()` messages for context
- **Traces**: HTTP requests/responses
- **Errors**: Exception messages and stacks

Don't just read error strings—parse JSON!

### 3. Iterate Incrementally

If fixing a test, rerun immediately to verify:

```
1. Analyze failure
2. Apply fix
3. Rerun test (glubean_run_local_file)
4. If still fails, iterate
5. If passes, move to next
```

### 4. Handle Pagination

When fetching events for large runs:

```
1. Fetch first page (limit=100)
2. Check hasMore
3. If true, fetch next page (afterSeq=nextCursor)
4. Repeat until hasMore=false
```

### 5. Poll Gracefully

When polling run status:

- Poll every 2-3 seconds (not every 100ms)
- Check for terminal status: `passed`, `failed`, `cancelled`, `exhausted`
- Stop polling when terminal

---

## Troubleshooting

### MCP Server Not Found

**Error**: "MCP server 'glubean' not configured"

**Fix**: Add to `~/.cursor/mcp.json`:

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

Restart Cursor.

---

### Authentication Failed

**Error**: "401 Unauthorized" when calling remote APIs.

**Fix**: Set `GLUBEAN_TOKEN` in environment:

```bash
export GLUBEAN_TOKEN=glb_token_xxxxxxxx
```

Or save in `~/.glubean/config`.

---

### Local Run Fails (Missing Vars)

**Error**: "Required var 'BASE_URL' not found"

**Fix**: AI should check `.env` exists:

```bash
# Check .env file
cat .env

# If missing, create it
echo "BASE_URL=https://api.example.com" > .env
```

---

### Remote Run Passes Locally, Fails in Cloud

**Cause**: Different environment variables.

**Fix**: AI guides user to:

1. Check environment group in dashboard
2. Add missing vars/secrets
3. Trigger new run

---

## Security Notes

### MCP Server Never Returns Secrets

When calling `glubean_run_local_file`, the response includes:

```json
{
  "varsCount": 2,
  "secretsCount": 1
}
```

But **never** the actual values. This prevents leaking credentials to the AI agent.

### Remote API Tokens

The `GLUBEAN_TOKEN` should have **least-privilege scopes**:

- `runs:read` - Read run status and events
- `runs:write` - Trigger runs

Create tokens in Dashboard → Settings → API Tokens.

---

## Next Steps

- **Cursor Skills**: Add Glubean-specific skills to guide AI prompts
- **Custom Assertions**: Extend SDK with domain-specific helpers
- **CI/CD Integration**: Use MCP to validate tests in PR checks
- **Advanced**: Chain multiple runs (e.g., smoke → full suite)
