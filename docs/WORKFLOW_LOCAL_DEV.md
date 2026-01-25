# Workflow: Local Developer Experience

This document describes the end-to-end workflow for developers writing and running API tests with Glubean.

---

## Overview

Developers write tests locally, iterate quickly with local execution, sync to cloud when ready, schedule tests from the web app, and monitor results in real-time.

---

## Prerequisites

1. **Install Glubean CLI**

   ```bash
   deno install -A -n glubean jsr:@glubean/cli
   ```

2. **Initialize Project**

   ```bash
   glubean init
   ```

   This creates:

   - `deno.json` with `@glubean/sdk` import map
   - `.env` for environment variables
   - `.env.secrets` for sensitive values (git-ignored)
   - Example test file

3. **Configure Environment**

   Edit `.env`:

   ```env
   BASE_URL=https://api.example.com
   ```

   Edit `.env.secrets` (never commit):

   ```env
   API_KEY=sk_live_xxxxxxx
   ```

---

## Phase 1: Write Tests Locally

### 1.1 Create Test File

Create `api.test.ts`:

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
    const apiKey = ctx.secrets.require("API_KEY");

    ctx.log("Fetching users...");

    const response = await fetch(`${baseUrl}/users`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const users = await response.json();

    ctx.assert(response.status === 200, "Should return 200");
    ctx.assert(Array.isArray(users), "Should return array");
    ctx.assert(users.length > 0, "Should have users");

    ctx.log(`Found ${users.length} users`);
  }
);

export const createUser = test(
  {
    id: "create-user",
    name: "Create New User",
    tags: ["users", "crud"],
  },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const apiKey = ctx.secrets.require("API_KEY");

    const newUser = {
      name: "Test User",
      email: `test-${Date.now()}@example.com`,
    };

    ctx.log("Creating user...", newUser);

    const response = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(newUser),
    });
    const created = await response.json();

    ctx.assert(response.status === 201, "Should return 201 Created");
    ctx.assert(created.id, "Should return user ID");
    ctx.assert(created.email === newUser.email, "Email should match");

    ctx.log(`Created user with ID: ${created.id}`);
  }
);
```

### 1.2 Run Tests Locally

**Run all tests:**

```bash
glubean run api.test.ts
```

**Run with filter (by tag, name, or id):**

```bash
# Run only smoke tests
glubean run api.test.ts --filter smoke

# Run only "create" tests
glubean run api.test.ts --filter create

# Run specific test by ID
glubean run api.test.ts --filter list-users
```

**Advanced options:**

```bash
# Enable verbose output (shows assertions and traces)
glubean run api.test.ts --verbose

# Write structured logs to file
glubean run api.test.ts --log-file --pretty

# Use custom .env file
glubean run api.test.ts --env-file .env.staging
```

**Output Example:**

```
🧪 Glubean Test Runner

File: /Users/dev/myapi/api.test.ts

Loaded 2 vars from .env
Discovering tests...

Running 2 test(s)...

  ● List All Users [users, smoke]
      Fetching users...
      Found 10 users
    ✓ PASSED (234ms)

  ● Create New User [users, crud]
      Creating user...
      Created user with ID: 12345
    ✓ PASSED (456ms)

─────────────────────────────────────
Tests: 2 passed
Total: 2
```

**When tests fail:**

```
  ● List All Users [users, smoke]
      Fetching users...
    ✗ FAILED (234ms)
      ✗ Should return 200
        Expected: 200
        Actual:   401
      Error: Unauthorized
```

---

## Phase 2: Push to GitHub

Once tests are working locally, push to your repository:

```bash
git add api.test.ts deno.json
git commit -m "Add user API tests"
git push origin main
```

**Important:**

- `.env` can be committed (no secrets)
- `.env.secrets` is git-ignored (never commit)
- `*.test.ts` files are automatically discovered by Glubean
- `metadata.json` should be committed

---

## Phase 2.5: Generate metadata.json

Glubean relies on `metadata.json` to understand available tests without parsing code.

**Generate metadata locally:**

```bash
glubean scan
```

**Validate metadata against local files:**

```bash
glubean validate-metadata
```

**Recommended:** add metadata checks in git hooks + CI:

```bash
glubean init --hooks --github-actions
```

**GitHub builder strict mode:**

- `metadata.json` must be committed to the repo.
- If missing, the first push will fail server-side until CI generates and pushes it.

---

## Phase 3: Sync to Glubean Cloud

### 3.1 Set Up Project

1. Log in to [Glubean Dashboard](https://app.glubean.com)
2. Create a new project (e.g., "My API Tests")
3. Connect your GitHub repository
4. Get your project ID (e.g., `prj_abc123`)

### 3.2 Authenticate CLI

Get your API token from the dashboard and set it:

```bash
export GLUBEAN_TOKEN=glb_token_xxxxxxxxxxxxxxxx
```

Or save in `~/.glubean/config`:

```json
{
  "token": "glb_token_xxxxxxxxxxxxxxxx",
  "apiUrl": "https://api.glubean.com"
}
```

### 3.3 Sync Tests to Cloud

**Sync current directory:**

```bash
glubean sync --project prj_abc123
```

**Sync specific directory:**

```bash
glubean sync --project prj_abc123 --dir ./tests
```

**Tag version explicitly:**

```bash
glubean sync --project prj_abc123 --tag v1.0.0
```

**Dry run (preview without uploading):**

```bash
glubean sync --project prj_abc123 --dry-run
```

**Output:**

```
☁️  Glubean Sync

Project:   prj_abc123
Version:   2026-02-04-12-30-45
Directory: /Users/dev/myapi

→ Scanning test files...
✓ Found 5 test(s) in 2 file(s)
  • api.test.ts
    - list-users [users, smoke]
    - create-user [users, crud]
  • auth.test.ts
    - login [auth, smoke]
    - refresh-token [auth]
    - logout [auth]

→ Generating metadata.json...
✓ Metadata generated

→ Creating bundle archive...
✓ Bundle created: .glubean-bundle-2026-02-04-12-30-45.tar (12.45 KB)

→ Initializing sync...
✓ Bundle ID: bun_xyz789

→ Uploading to cloud storage...
✓ Upload complete

→ Finalizing sync...
✓ Sync finalized

Bundle Summary:
   ID:      bun_xyz789
   Version: 2026-02-04-12-30-45
   Tests:   5
   Files:   2

✓ Sync complete!
```

---

## Phase 4: Schedule from Web App

### 4.1 Manual Trigger (On-Demand)

1. Go to [Glubean Dashboard](https://app.glubean.com) → Your Project
2. Click **"Run Now"**
3. Select bundle version (defaults to latest)
4. Optionally filter by tags
5. Click **"Start Run"**

### 4.2 Create Job (Scheduled/Recurring)

1. Go to **Jobs** → **Create Job**
2. Configure:
   - **Name**: "Smoke Tests - Production"
   - **Bundle**: Latest or pin to specific version
   - **Filter**: `smoke` (run only smoke-tagged tests)
   - **Schedule**: Cron expression (e.g., `0 */6 * * *` = every 6 hours)
   - **Environment Group**: Select env vars (e.g., "Production")
3. Save job

### 4.3 Webhook Trigger (CI/CD)

When auto-deploy is enabled:

- Every push to `main` triggers a build
- New bundle is automatically created
- Optionally auto-trigger test run

---

## Phase 5: Monitor Results

### 5.1 Real-Time Logs (CLI)

**Trigger and follow logs:**

```bash
glubean trigger --project prj_abc123 --follow
```

**Output (live-streamed):**

```
🚀 Glubean Trigger

Project: prj_abc123
Bundle:  (latest)

→ Creating run...
✓ Run created
  Run ID:    run_123456
  Bundle ID: bun_xyz789

View in browser:
  https://app.glubean.com/runs/run_123456

Live output:
─────────────────────────────────────
  Fetching users...
  Found 10 users
  ✓ Should return 200
  Creating user...
  Created user with ID: 12345
  ✓ Should return 201 Created
─────────────────────────────────────

Result: PASSED
Tests:  5 passed
Time:   1234ms
```

### 5.2 Web Dashboard

Visit `https://app.glubean.com/runs/run_123456`:

- **Overview**: Status, duration, summary
- **Tests**: List of all tests with pass/fail status
- **Timeline**: Execution order and timing
- **Logs**: Full output with `ctx.log()` entries
- **Traces**: HTTP requests/responses (when using `ctx.trace()`)
- **Assertions**: All `ctx.assert()` results with actual vs expected values

### 5.3 Final Result (Poll Without Follow)

**Check run status:**

```bash
# Get run status JSON
curl -H "Authorization: Bearer $GLUBEAN_TOKEN" \
  https://api.glubean.com/open/v1/runs/run_123456
```

**Response:**

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

**Get run events (paginated):**

```bash
# Get first 100 events
curl -H "Authorization: Bearer $GLUBEAN_TOKEN" \
  "https://api.glubean.com/open/v1/runs/run_123456/events?limit=100"

# Get next page (after seq 100)
curl -H "Authorization: Bearer $GLUBEAN_TOKEN" \
  "https://api.glubean.com/open/v1/runs/run_123456/events?afterSeq=100&limit=100"
```

**Response:**

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

---

## Complete Workflow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. LOCAL DEVELOPMENT                                              │
│                                                                    │
│  Write tests      Run locally      Iterate until passing          │
│  api.test.ts  →   glubean run  →   Fix failures  →  ✓ All pass   │
│                                                                    │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ 2. VERSION CONTROL                                                │
│                                                                    │
│  git add api.test.ts                                              │
│  git commit -m "Add user API tests"                               │
│  git push origin main                                             │
│                                                                    │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ 3. SYNC TO CLOUD                                                  │
│                                                                    │
│  glubean sync --project prj_abc123                                │
│                                                                    │
│  ┌─────────────┐    ┌────────────┐    ┌─────────────┐            │
│  │ Scan files  │ →  │ Create tar │ →  │ Upload to   │            │
│  │ Extract meta│    │ bundle     │    │ S3 + save   │            │
│  └─────────────┘    └────────────┘    └─────────────┘            │
│                                                                    │
│  Result: Bundle bun_xyz789 (5 tests, 2 files)                    │
│                                                                    │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ 4. SCHEDULE / TRIGGER                                             │
│                                                                    │
│  Option A: Web Dashboard                                          │
│    • Click "Run Now" → select bundle → start                      │
│    • Create Job → schedule cron → save                            │
│                                                                    │
│  Option B: CLI                                                    │
│    glubean trigger --project prj_abc123 --follow                  │
│                                                                    │
│  Option C: API                                                    │
│    POST /open/v1/runs { projectId, bundleId }                     │
│                                                                    │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ 5. MONITOR RESULTS                                                │
│                                                                    │
│  Real-time (streaming):                                           │
│    • CLI: glubean trigger --follow                                │
│    • Web: Live tail in dashboard                                  │
│    • API: SSE /runs/:id/events/stream                             │
│                                                                    │
│  Final result (polling):                                          │
│    • Web: Run detail page                                         │
│    • API: GET /open/v1/runs/:id                                   │
│    • API: GET /open/v1/runs/:id/events (paginated)                │
│                                                                    │
│  Result: ✓ PASSED (5/5 tests, 1234ms)                            │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

---

## Best Practices

### Environment Management

1. **Never commit secrets**

   - Use `.env.secrets` for API keys, tokens
   - Add to `.gitignore`

2. **Use environment groups**

   - Create "Development", "Staging", "Production" groups in dashboard
   - Each group has its own vars/secrets
   - Select appropriate group when scheduling

3. **Override for local testing**
   - Use `--env-file` to test against different environments
   ```bash
   glubean run api.test.ts --env-file .env.staging
   ```

### Test Organization

1. **Use tags liberally**

   ```typescript
   tags: ["smoke", "auth", "critical"];
   ```

   - Filter locally: `glubean run --filter smoke`
   - Filter in jobs: Set filter field to "smoke"

2. **Meaningful test IDs**

   ```typescript
   id: "auth-login-success"; // Good: descriptive
   id: "test1"; // Bad: meaningless
   ```

3. **Structured logging**
   ```typescript
   ctx.log("Creating user", { email: newUser.email });
   // Shows in dashboard with expandable JSON
   ```

### Iteration Workflow

**During development:**

1. Write test
2. Run locally: `glubean run test.ts`
3. Fix failures
4. Repeat until green

**Before push:**

1. Run all tests: `glubean run test.ts --verbose`
2. Check log file: `cat test.log`
3. Commit if all pass

**After push:**

1. Sync to cloud: `glubean sync --project <id>`
2. Trigger run: `glubean trigger --project <id> --follow`
3. Verify in dashboard

---

## Troubleshooting

### Test fails locally

1. Check `.env` is loaded: `Loaded X vars from .env`
2. Verify secrets exist: `ls .env.secrets`
3. Use `--verbose` to see all assertions
4. Use `--log-file --pretty` to inspect JSON

### Sync fails

1. Verify auth: `echo $GLUBEAN_TOKEN`
2. Check project ID is correct
3. Ensure network connectivity to `api.glubean.com`
4. Inspect bundle: `glubean sync --dry-run`

### Run fails in cloud but passes locally

1. Check environment group has correct vars/secrets
2. Verify bundle version is latest: check bundle ID
3. Compare logs: local `test.log` vs dashboard
4. Check worker timeout (default 5 min)

---

## Next Steps

- **CI/CD Integration**: Add `glubean sync` to your CI pipeline
- **Notifications**: Configure Slack/email alerts for failed runs
- **Metrics**: View trends and SLOs in dashboard analytics
- **Advanced**: Use `testSuite` for complex test organization
