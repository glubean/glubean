# Glubean API E2E Tests

This directory contains end-to-end tests for the Glubean server, written using the Glubean SDK itself (dogfooding!).

## Prerequisites

1. **Glubean server running locally**
   ```bash
   # In glubean-v1/
   pnpm dev
   ```
   Server should be running at `http://localhost:3002`

2. **Deno installed**
   ```bash
   # macOS
   brew install deno
   ```

## Setup

1. **Get an API Key**

   The tests require authentication. You need to create an API key:

   a. Open your browser and go to `http://localhost:3000`
   b. Login with Google/GitHub
   c. Go to **Settings > API Keys**
   d. Click **Create New Key**
   e. Copy the key (it's only shown once!)

2. **Configure secrets**

   Create `.env.secrets` with your API key:
   ```bash
   echo "API_KEY=glubean_your_key_here" > .env.secrets
   ```

   The `.env` file already contains the default `BASE_URL`.

## Running Tests

```bash
cd examples/glubean-api

# Run all tests
deno task test

# Run auth tests only
deno task test:auth

# Run project tests only
deno task test:project

# Run specific test by filter
deno run -A ../../packages/cli/mod.ts run . --filter="project-list"
```

## Test Files

| File | Description |
|------|-------------|
| `auth.test.ts` | Authentication endpoint tests (status, profile) |
| `project.test.ts` | Project CRUD tests (list, create, update, delete) |

## Test Tags

Tests are tagged for easy filtering:

- `smoke` - Quick sanity checks
- `auth` - Authentication related
- `project` - Project CRUD
- `security` - Security/permission checks
- `integration` - Full lifecycle tests

Run by tag:
```bash
deno run -A ../../packages/cli/mod.ts run . --filter="smoke"
```

## Troubleshooting

### "API_KEY not set" messages

Make sure `.env.secrets` exists and contains your API key:
```bash
cat .env.secrets
# Should show: API_KEY=glubean_...
```

### Connection refused

Make sure the Glubean server is running at the correct URL:
```bash
curl http://localhost:3002/auth/status
```

### 401 Unauthorized with API key

Your API key might be expired or invalid. Create a new one in the dashboard.
