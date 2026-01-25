# Changelog

All notable changes to the Glubean OSS project will be documented in this file.

## 2026-02-13

### @glubean/cli

- **Directory-based convention**: `tests/` and `explore/` directories replace `*.explore.ts` suffix
- `glubean run` now defaults to `testDir` (no target argument required)
- `glubean run --explore` scans `exploreDir`
- Config: `testDir` / `exploreDir` in `deno.json → glubean.run`
- `glubean init` scaffold updated: creates `tests/`, `explore/`, `data/`, `context/` directories

### @glubean/scanner

- Only scans `*.test.ts` files (aligned with directory convention)

### VSCode Extension

- **One-click setup**: auto-installs Deno + CLI with progress notification
- Context-aware prompts (different messages for missing Deno vs missing CLI vs both)
- "Learn more" button opens bundled `docs/setup.md` explainer
- Cross-platform installer: curl/wget fallback (Linux), PowerShell bypass (Windows)
- Command renamed: "Glubean: Setup" (was "Check Dependencies")
- `test.pick` CodeLens buttons for individual examples

## 2026-02-11

### @glubean/sdk@0.5.1

- Fluent `ctx.expect()` assertion API with `.toBe()`, `.toEqual()`, `.toContain()`, `.toMatch()`, etc.
- `ctx.http` client with retry, timeout, and schema validation
- `ctx.trace()` for HTTP request/response recording
- `ctx.metric()` for performance measurement
- `ctx.pollUntil()` for async polling patterns
- Data loading utilities: `fromCsv()`, `fromYaml()`, `fromJsonl()`, `fromDir()`
- Builder API (`TestBuilder`) for multi-step tests with shared state
- `test.each()` for data-driven test generation
- `test.pick()` for example-driven tests with random selection

### @glubean/runner@0.2.4

- Sandboxed Deno subprocess execution
- Structured event streaming (logs, assertions, traces, metrics)
- V8 Inspector debug support (`--inspect-brk`)
- HTTP interception and tracing
- Timeout and retry handling

### @glubean/cli@0.2.25

- 11 commands: `init`, `run`, `scan`, `diff`, `coverage`, `context`, `sync`, `trigger`, `upgrade`, `validate-metadata`
- Interactive project scaffolding with `glubean init`
- Environment file support with paired secrets (`.env` / `.env.secrets`)
- Trace file generation (`.glubean/traces/`)
- OpenAPI diff and coverage analysis
- AI context generation
- Self-update via JSR

### VSCode Extension@0.1.0

- Test Explorer integration with inline play buttons
- `*.test.ts` discovery with directory-based grouping (Tests / Explore)
- Live output streaming to Test Results panel
- Auto-open `.trace.jsonc` files after execution
- Environment switcher (status bar)
- Re-run last request (`Cmd+Shift+R`)
- Diff with previous run
- Variable hover preview (`vars.require` / `secrets.require`)
- Copy as cURL
- Breakpoint debugging via V8 Inspector
- Dependency detection with guided installation
