# Glubean CLI Reference

## Commands Overview

| Command | Purpose |
|---------|---------|
| `glubean run` | Run tests locally |
| `glubean scan` | Generate metadata.json from test files |
| `glubean sync` | Upload test bundle to Glubean Cloud |
| `glubean trigger` | Trigger a remote run on Cloud |
| `glubean login` | Authenticate with Glubean Cloud |
| `glubean init` | Initialize a new test project (interactive wizard) |
| `glubean docs pull` | Download SDK lens docs to `~/.glubean/docs/` for AI agents |
| `glubean redact` | Preview redaction on a result JSON file |
| `glubean config mcp` | Configure MCP server for AI coding tools (Claude Code, Cursor, Windsurf) |
| `glubean config skill` | Install Glubean test-writing skill for AI coding tools |
| `glubean spec split` | Dereference $refs and split OpenAPI spec into per-endpoint files |
| `glubean patch` | Merge an OpenAPI spec with its `.patch.yaml` overlay |
| `glubean validate-metadata` | Validate metadata.json against local test files |

---

## glubean run

Run tests from a file, directory, or glob pattern.

```bash
glubean run                              # Run all tests (from testDir in package.json)
glubean run tests/api/                   # Run a directory
glubean run tests/api/health.test.ts     # Run a single file
glubean run "tests/**/*.test.ts"         # Run by glob pattern
```

### Filtering

```bash
glubean run --filter smoke               # Match test name or ID substring
glubean run --tag api                    # Match exact tag
glubean run --tag api --tag auth         # Multiple tags (OR by default)
glubean run --tag api --tag auth --tag-mode and  # All tags must match
glubean run --pick basic,edge-case       # Select specific test.pick examples by key
```

### Output & Debugging

```bash
glubean run --verbose                    # Show traces, assertions in console
glubean run --log-file                   # Write logs to <testfile>.log
glubean run --log-file --pretty          # Pretty-print JSON in log files
glubean run --result-json                # Write results to .result.json
glubean run --result-json results.json   # Write to custom path
glubean run --reporter junit             # JUnit XML output
glubean run --reporter junit:report.xml  # JUnit to specific file
glubean run --emit-full-trace            # Include full request/response in traces
glubean run --inspect-brk                # Attach V8 debugger (pauses until attached)
```

### Failure Handling

```bash
glubean run --fail-fast                  # Stop on first failure
glubean run --fail-after 3               # Stop after 3 failures
glubean run --ci                         # CI mode: --fail-fast + --reporter junit
```

### Cloud Upload

```bash
glubean run --upload                     # Run + upload results to Cloud
glubean run --upload --project proj_abc  # Specify project (or GLUBEAN_PROJECT_ID env)
glubean run --upload --token gpt_xxx     # Specify token (or GLUBEAN_TOKEN env)
```

### Config

```bash
glubean run --env-file .env.staging      # Use alternate .env file
glubean run --config custom.json         # Use alternate config file
glubean run --trace-limit 50             # Keep up to 50 trace files per test (default: 20)
```

---

## glubean scan

Generate metadata.json from test files. Used internally by sync and for inspecting test inventory.

```bash
glubean scan                             # Scan current directory
glubean scan --dir ./tests               # Scan specific directory
glubean scan --out metadata.json         # Custom output path
```

---

## glubean sync

Upload test bundle to Glubean Cloud. Bundles contain test metadata and source for remote execution.

```bash
glubean sync --project proj_abc          # Sync to a project
glubean sync --project proj_abc --tag v1.2.0  # Tag the bundle version
glubean sync --dry-run                   # Generate bundle without uploading
glubean sync --dir ./tests               # Specify directory to scan
```

---

## glubean trigger

Trigger a remote run on Glubean Cloud (requires synced bundle).

```bash
glubean trigger --project proj_abc              # Run latest bundle
glubean trigger --project proj_abc --bundle bnd_xyz  # Run specific bundle
glubean trigger --project proj_abc --job job_123     # Run a specific job
glubean trigger --project proj_abc --follow     # Tail logs until completion
```

---

## glubean login

Authenticate with Glubean Cloud. Stores credentials locally.

```bash
glubean login                            # Interactive login
```

---

## glubean init

Initialize a new test project with interactive wizard.

```bash
glubean init                             # Start wizard in current directory
```

Creates: `package.json`, `config/`, `tests/`, `.env.example`, `.env.secrets.example`, `AGENTS.md`.

---

## glubean docs pull

Download `@glubean/lens` (SDK reference + patterns) to `~/.glubean/docs/` for AI agent consumption.

```bash
glubean docs pull                       # Pull latest lens docs
```

---

## glubean redact

Preview redaction on a result JSON file. Applies configured redaction rules to see what would be masked.

```bash
glubean redact                           # Redact default glubean-run.result.json
glubean redact -i results.json           # Redact specific file
glubean redact --stdout                  # Output to stdout
```

---

## glubean config mcp

Configure the Glubean MCP server for AI coding tools.

```bash
glubean config mcp                       # Auto-detect tool
glubean config mcp --target claude-code  # Configure for Claude Code
glubean config mcp --target cursor       # Configure for Cursor
glubean config mcp --remove              # Remove MCP configuration
```

---

## glubean config skill

Install the Glubean test-writing skill for AI coding tools.

```bash
glubean config skill                     # Auto-detect tool
glubean config skill --target claude-code
glubean config skill --remove            # Remove skill
```

---

## glubean spec split

Dereference `$ref`s and split an OpenAPI spec into per-endpoint files for AI consumption.

```bash
glubean spec split openapi.yaml          # Split to <name>-endpoints/ directory
glubean spec split openapi.yaml -o out/  # Custom output directory
```

---

## glubean patch

Merge an OpenAPI spec with its `.patch.yaml` overlay and write the complete spec.

```bash
glubean patch openapi.yaml               # Auto-discover .patch.yaml
glubean patch openapi.yaml --patch custom.patch.yaml
glubean patch openapi.yaml -o merged.json
glubean patch openapi.yaml --stdout      # Write to stdout
```

---

## glubean validate-metadata

Validate metadata.json against local test files to detect drift.

```bash
glubean validate-metadata                # Validate in current directory
glubean validate-metadata -d ./tests     # Specify project root
```

---

## Environment Variables

| Variable | Purpose | Used by |
|----------|---------|---------|
| `GLUBEAN_TOKEN` | Auth token (`gpt_` prefix) | `run --upload`, `sync`, `trigger` |
| `GLUBEAN_PROJECT_ID` | Default project ID | `run --upload`, `sync`, `trigger` |
| `GLUBEAN_API_URL` | API server URL (default: `https://api.glubean.com`) | All cloud commands |

---

## Workflow: AI-Assisted Test Writing

```bash
# 1. Write tests (manually or with AI — point AI at your OpenAPI spec directly)

# 2. Run and verify
glubean run --verbose

# 3. Upload results
glubean run --upload
```
