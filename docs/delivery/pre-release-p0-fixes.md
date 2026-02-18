# Pre-Release P0 Fixes — Context Document

> Created 2026-02-18. Use this document to continue work in a new chat session.

## Background

We just completed the `SharedRunConfig` implementation (glubean/glubean#1) across
all 4 consumer packages (runner, cli, worker, mcp). That work is on the
`docs/shared-run-config` branch and has been pushed to origin. The design doc is
at `docs/architecture/shared-run-config.md`.

During a pre-release audit, we identified 5 P0 blockers, 4 P1 items, and 3 P2
items. The P0s must be resolved before publishing to JSR.

## Current branch state

- **Branch**: `docs/shared-run-config` (pushed, no PR yet)
- **Uncommitted changes**: The SharedRunConfig implementation code (runner,
  cli, worker, mcp changes) is committed. Worker test breakage from the
  migration is NOT yet fixed.

## P0 — Release Blockers

### P0-1: Scanner version drift breaks CLI type-check

- `packages/scanner/deno.json` is at `0.11.0`
- `packages/cli/deno.json` depends on `@glubean/scanner@^0.10.0`
- `deno check` reports errors at `packages/cli/commands/run.ts:284-285`
- **Fix**: Either bump all packages to `0.11.0`, or ensure scanner's public API
  is backward-compatible with `^0.10.0`. Decision needed on version strategy.

### P0-2: Worker tests use old config fields (our breakage)

The SharedRunConfig migration removed `allowNet`, `executionTimeoutMs`,
`executionConcurrency`, `stopOnFailure` from `WorkerConfig` and replaced them
with `run: SharedRunConfig` + `taskTimeoutMs`.

Two test files still construct `WorkerConfig` literals with the old fields:

- `packages/worker/executor_test.ts:23` — `createTestConfig()` helper returns
  old flat fields (`allowNet`, `executionTimeoutMs`, `executionConcurrency`,
  `stopOnFailure`)
- `packages/worker/logger_test.ts:20` — `createConfig()` helper returns old
  flat fields

**Fix**: Update both helpers to use the new `WorkerConfig` shape:

```typescript
// Old (broken):
allowNet: "*",
executionTimeoutMs: 30000,
executionConcurrency: 1,
stopOnFailure: false,

// New (correct):
run: {
  ...WORKER_RUN_DEFAULTS,
  allowNet: "*",
},
taskTimeoutMs: 30000,
```

### P0-3: GraphQL `gql` test expects whitespace collapsing

- `packages/graphql/mod.ts:280-289` — `gql()` is an identity tagged template
  (concatenates strings as-is, preserves whitespace)
- `packages/graphql/mod_test.ts:171-179` — test expects the multiline query to
  be collapsed to `"query GetUser { user { id } }"`
- The function does NOT collapse whitespace, so the test fails
- **Fix**: Either (a) make `gql()` collapse whitespace (common in GraphQL
  tooling), or (b) fix the test expectation to match the raw multiline string.
  Option (a) is recommended — most `gql` implementations strip indentation.

### P0-4: Release CI skips type-check

- `.github/workflows/release.yml:31` runs `deno test -A --no-check`
- This misses type regressions like P0-1 and P0-2
- **Fix**: Add `deno check **/*.ts` step before test, or change to
  `deno test -A` (without `--no-check`)

### P0-5: Redaction package.json version mismatch

- `packages/redaction/package.json:3` says `0.10.0`
- `packages/redaction/deno.json:3` says `0.10.1`
- **Fix**: Align `package.json` to `0.10.1`

## P1 — High Value (same release window)

### P1-1: Worker logger should use `@glubean/redaction`

- `packages/worker/logger.ts:31` has hand-rolled field-matching redaction
- Should use `@glubean/redaction` plugin engine for consistency and coverage
  (JWT, AWS keys, credit cards, etc.)

### P1-2: SharedRunConfig publish ordering

- Runner must be published first (new public API: `SharedRunConfig`,
  `fromSharedConfig`, presets)
- Then CLI, Worker, MCP (consumers)
- Update JSR dependency ranges in consumer `deno.json` files

### P1-3: Worker `networkPolicy` dead field

- `packages/worker/types.ts:187` defines `networkPolicy` in `RuntimeContext`
- No code in the execution path reads it
- Either implement (wire to `SharedRunConfig.allowNet`) or remove

### P1-4: Worker main loop has no tests

- `packages/worker/loop.ts` is 729 lines with no `loop_test.ts`
- Core orchestration path (claim → heartbeat → execute → flush)

## P2 — Can Defer

1. MCP test coverage (`packages/mcp/` has no `Deno.test`)
2. SDK `any` type convergence (mostly generic bridges, low user impact)
3. CLI URL configurability (`packages/cli/lib/constants.ts:6`,
   `packages/cli/commands/run.ts:1196`)

## Suggested execution order for P0s

1. **P0-2** — Fix worker tests (our breakage, quick, unblocks type-check)
2. **P0-5** — Fix redaction version (one-line)
3. **P0-3** — Fix GraphQL gql (small code change)
4. **P0-1** — Version alignment (needs decision: unified bump to 0.11.0?)
5. **P0-4** — Add `deno check` to CI

## Key files reference

| File | Role |
|---|---|
| `packages/runner/config.ts` | SharedRunConfig, presets, helpers (NEW) |
| `packages/runner/executor.ts` | `fromSharedConfig`, `buildEnvOverlay`, `maskEnvPrefixes` |
| `packages/runner/mod.ts` | Public exports |
| `packages/cli/lib/config.ts` | `toSharedRunConfig`, new fields in GlubeanRunConfig |
| `packages/cli/commands/run.ts` | Uses `fromSharedConfig` + `toSingleExecutionOptions` |
| `packages/worker/config.ts` | `WorkerConfig.run: SharedRunConfig` + `taskTimeoutMs` |
| `packages/worker/executor.ts` | Uses `fromSharedConfig` + `maskEnvPrefixes` |
| `packages/mcp/mod.ts` | Uses `LOCAL_RUN_DEFAULTS` + `fromSharedConfig` |
| `docs/architecture/shared-run-config.md` | Design document |
