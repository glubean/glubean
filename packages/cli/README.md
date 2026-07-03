# @glubean/cli

The Glubean command-line tool. Run tests, sync results to Cloud, scaffold projects, manage environments.

```bash
npm install -g glubean
```

Or invoke once without installing:

```bash
npx glubean <command>
```

Both `glubean` and the short alias `gb` are installed.

## Quick start

```bash
glubean init                    # interactive wizard
glubean run                     # run all tests in testDir
glubean run path/to/file.test.ts
glubean run --filter checkout --tag smoke
glubean run --profile ci --upload   # CI profile + push results to Cloud
glubean load                    # discover and run *.load.ts plans
glubean login                   # authenticate with Glubean Cloud
```

See the full project README at the [repo root](../../README.md) for the broader Glubean story (SDK, MCP, agent workflow).

## Commands

### `init`

Scaffold a new Glubean project. The interactive wizard asks what mode you want and writes the right config.

```bash
glubean init
glubean init --contract-first         # contracts/ + tests/ layout
glubean init --ai-tools               # also configure MCP server + AI skill
glubean init --hooks --github-actions # git hooks + CI workflow
glubean init --no-interactive --base-url https://api.example.com
```

### `run [target]`

Run tests from a file, a directory, or a glob. Defaults to the project's `testDir`.

```bash
glubean run                                # everything in testDir
glubean run tests/checkout.test.ts         # one file
glubean run tests/checkout                 # one directory
glubean run --explore                      # use exploreDir instead of testDir
glubean run --filter login                 # name or id substring
glubean run --tag smoke,critical           # by tag (comma or repeatable)
glubean run --tag-mode and                 # all tags must match
glubean run --pick happyPath               # specific test.pick example
glubean run --fail-fast                    # stop on first failure
glubean run --result-json                  # write .result.json
glubean run --reporter junit               # JUnit XML
glubean ci run                             # use the `ci` profile from glubean.yaml
glubean run --upload --project <id>        # push to Glubean Cloud
glubean run --inspect-brk                  # attach a debugger
```

Useful flags:

| Flag | Effect |
|------|--------|
| `--env-file <path>` | Load a specific `.env` file (default: the active env set via `glubean env use`, else `.env` — see [`env`](#env)) |
| `--config <paths>` | One or more config files (comma-separated or repeatable) |
| `--verbose` | Show traces and assertions inline |
| `--log-file` | Write per-test logs to disk |
| `--emit-full-trace` | Include full headers and bodies in HTTP traces |
| `--infer-schema` | Infer JSON Schema from response bodies |
| `--trace-limit <n>` | Cap trace files per test (default 20) |
| `--meta key=value` | Attach custom metadata to the run (repeatable) |
| `--no-session` | Skip session setup/teardown |
| `--no-update-check` | Skip the npm update check |

### `scan`

Statically analyze a directory and emit `metadata.json` describing the test suite (used by IDE integrations and Cloud upload). Also extracts contract metadata when `.contract.ts` files are present.

```bash
glubean scan tests/
glubean scan --upload --project <id>      # push contract metadata without running
```

### `migrate`

Preview or apply v0.1.x -> v10 project migrations. The command rewrites safe legacy patterns and reports anything that needs manual review.

```bash
glubean migrate
glubean migrate --dir path/to/project
glubean migrate --apply
```

Current automatic changes:

| Pattern | Migration |
|---------|-----------|
| `contract.http("id", spec)` | Adds a scoped `contract.http.with(...)` instance and calls it |
| `import "@glubean/grpc"` / `import "@glubean/graphql"` | Moves plugin installation into `glubean.setup.ts` |

Manual review items are reported for removed case-level `setup` / `teardown`, legacy `definePlugin((runtime) => ...)`, and cases with `needs` that should be wrapped in `defineHttpCase<Needs>(...)`.

### `validate-metadata`

Verify that a previously generated `metadata.json` still matches the local files.

```bash
glubean validate-metadata metadata.json
```

### `load [target]`

Discover and run load plans (`*.load.ts`) in a project. Writes structured artifacts with latency histograms, over-time timelines, per-endpoint breakdowns, threshold evaluation, and failure/slow-transaction samples.

```bash
glubean load                        # discover all *.load.ts in the project
glubean load tests/shop.load.ts     # run a specific load plan
glubean load --upload               # run and push results to Cloud
```

Load plans are authored with `@glubean/sdk/load`:

```ts
// shop.load.ts
import { loadRunner, loadScenario } from "@glubean/sdk/load";

export default loadRunner({
  scenarios: [
    loadScenario("browse", { weight: 70, vus: 50, duration: "30s", fn: async (ctx) => {
      await ctx.http.get("products").json();
    }}),
    loadScenario("checkout", { weight: 30, vus: 20, duration: "30s", fn: async (ctx) => {
      await ctx.http.post("orders", { json: { item: "A" } }).json();
    }}),
  ],
  thresholds: { "p95 < 500": true },
});
```

### `login`

Authenticate with Glubean Cloud via browser device authorization (RFC 8628). Opens your browser, polls for token confirmation, and stores the token under `~/.glubean/`.

```bash
glubean login
```

Alternatively, set `GLUBEAN_TOKEN` in your environment to skip the interactive flow (useful in CI).

### `patch <spec>`

Merge an OpenAPI spec with a sibling `.patch.yaml` and write the resolved spec.

```bash
glubean patch openapi.yaml
```

### `spec split <spec>`

Dereference all `$ref`s and split a spec into per-endpoint files. Useful for feeding individual endpoints to an agent.

```bash
glubean spec split openapi.yaml
```

### `redact`

Preview how the redaction policy would transform a `.result.json` before uploading.

```bash
glubean redact tests/checkout.result.json
```

### `config mcp`

Install and configure the Glubean MCP server for your editor (Claude Code, Cursor, Windsurf, and others). Auto-detects installed tools.

```bash
glubean config mcp
```

### `env`

Manage which `.env.<name>` file is active for `glubean run` (and `sync`/`load`) when no explicit `--env-file` is given. The active env is sticky — it's written to `.glubean/active-env` and stays in effect for every future run in that directory until you `glubean env reset` or pass `--env-file` explicitly.

```bash
glubean env list                # show available environments
glubean env use staging         # activate .env.staging
glubean env                     # print current active env
glubean env reset               # clear active env (use default .env)
```

**Prod-like active envs are refused implicitly.** If the active env is named `prod` or `production`, `glubean run`/`sync`/`load` will error instead of silently loading `.env.prod` — that stickiness is exactly what caused a run to be misdirected to a production project in the past (GLU-88). Pass `--env-file .env.prod` explicitly when you really mean it, or `glubean env reset` to fall back to `.env`.

### `upgrade`

Self-upgrade to the latest published version.

```bash
glubean upgrade
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GLUBEAN_CWD` | Override the working directory (useful for shell aliases) |
| `GLUBEAN_PROJECT_ID` | Default Cloud project for `--upload` |
| `GLUBEAN_TOKEN` | Auth token for Cloud (alternative to `glubean login`) |
| `GLUBEAN_PLATFORM_API_URL` | Override the Platform API URL for `run`/`load`/`sync`/`login` uploads (preferred — see GLUBEAN_API_URL below) |
| `GLUBEAN_API_URL` | Legacy alias for the Platform API URL; still read as a fallback when `GLUBEAN_PLATFORM_API_URL` is unset. Some projects also use this name for an unrelated Dashboard API host — set `GLUBEAN_PLATFORM_API_URL` to disambiguate |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Test failure or CLI error |

## Links

- [Glubean repo](https://github.com/glubean/glubean) — SDK, runner, scanner, plugins
- [Docs](https://docs.glubean.com) — full documentation
- [Cloud](https://app.glubean.com) — hosted run history and analytics
