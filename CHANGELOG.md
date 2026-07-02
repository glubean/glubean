# Changelog

All notable changes to the Glubean SDK and CLI packages are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [lockstep semver](./CLAUDE.md#version-policy) — all packages share one version number.

---

## [Unreleased]

### Added
- **Custom metrics authoring** (`@glubean/sdk/load`) — `rate()`, `trend()`, `counter()` metric builders for user-defined load signals (`A1`).
- **Custom metrics fold + gate thresholds** (`@glubean/runner`) — custom metric values are folded into the load artifact alongside built-in metrics; threshold evaluation supports custom metric names (`A2`).

---

## [0.8.4] — 2026-07-02

> Scope: lockstep release re-aligning all 13 packages on one version (mixed 0.8.1 / 0.8.2 / 0.8.3 → 0.8.4). `@glubean/sdk` 0.8.4 is a version-only republish of 0.8.2 (see [0.8.2] below — F31 zod JSON Schema fix + the sdk authoring surface that rode along); `@glubean/cli` picks up everything since its independent 0.8.3 (2026-06-27); all other packages ship everything since 0.8.1. Unchanged packages (`auth`, `graphql`, `grpc`, `oauth-code`, `redaction`, `glubean` meta) are republished at 0.8.4 per lockstep policy. There is no 0.8.3 lockstep release — 0.8.3 was a cli-only manual publish with no tag.

### Changed

#### BREAKING — MCP cloud tools migrate to the `/v1` ingest contract (`@glubean/mcp`, GLU-77)
- **`glubean_open_trigger_run` is removed and replaced by `glubean_open_upload_run` — the SEMANTICS changed, not just the name.** The old tool asked the retired Open Platform (`POST /open/v1/runs`) to execute a test bundle *remotely on the platform*. The new tool works in the opposite direction: it **uploads the most recent local `glubean_run_local_file` run** to the platform (`POST /v1/projects/{projectId}/targets/{targetId}/runs`) — the same ingest contract and credential conventions as `glubean run --upload`. Nothing executes remotely anymore; runs execute locally and their results are reported. The payload is deep-redacted client-side before upload, and HTTP traces are never uploaded (the local trace view keeps authorization headers).
- **`glubean_open_get_run` / `glubean_open_get_run_events` now read the target-scoped `/v1` endpoints.** Events are stored per test — `glubean_open_get_run_events` takes a `testId` (omit it to list the run's tests); the `afterSeq` cursor is gone (no run-level event log in `/v1`). Practical baseline: on 0.8.1 every `/open/v1` call 404'd because the legacy Open Platform was retired — these tools were unusable before this migration.
- Credential/environment resolution mirrors the CLI precedence (explicit argument > `GLUBEAN_*` env vars > `.env`/`.env.secrets` > `~/.glubean/credentials.json`) and defaults both credentials and the environment label to the env file the run was executed with. A stable `clientRunId` is minted per local snapshot, so re-uploading the same run *replaces* the Cloud run instead of duplicating it.

### Added
- **`glubean sync`** (`@glubean/cli`) — upload test-definition projections to Cloud (`C2`): test shapes captured via a sandboxed dry-run (incl. `ctx.when`/`ctx.switch`/`ctx.while` branches and per-row data-driven shapes), contract + workflow projections (`C1`), and project tags. Honors project redaction config and fails closed on invalid config, dropped files, or projection errors.
- **OpenAPI 3.1 from HTTP contracts** (`@glubean/cli`) — render an OpenAPI 3.1 document from a project's HTTP contracts and include it in `sync`.
- **Run selectors** (`@glubean/cli`, with the `{id, rowIndex}` selector protocol across `@glubean/sdk`/`engine`/`runner`, `B2-M3`) — `--only-id` / `--row` target a single test or data row; `--rerun-failed` re-runs exactly the previous run's failures.
- **Screenshots as first-class evidence** (`@glubean/browser`, `BT-M3`) — `EvidenceSession.captureShot()` / `screenshots`, `ScreenshotMode` with a 3-trigger policy (failure / checkpoint / always-on manual).
- **Shared `EvidenceSession` CDP session** (`@glubean/browser`, `BT-M2`) — one self-opened CDP session shared by network trace, Fetch mock, and emulation; capability-gated, with guardrails against viewport takeover and double-opened Fetch domains.
- **`ctx.http.track(pattern)` runtime** (`@glubean/runner`, `@glubean/engine`) — runner/engine execution support for the sdk-side `.track()` API published in 0.8.2 (pin a raw HTTP call to its canonical endpoint).

### Fixed
- **Artifact upload scope (`ART1`)** (`@glubean/cli`) — `--upload` sends only *this run's* screenshots instead of the whole artifact directory (A), and unlinks local screenshots after a confirmed upload; `--keep-local` opts out (B).
- **Empty-test-file gate is provenance-verified** (`@glubean/scanner`) — the scanner only flags empty test files that verifiably import the Glubean SDK (multi-line + comment safe) and gates on parse failure rather than import heuristics; static scan tags are used as a fallback when the runner predates shape tags.

---

## [0.8.2] — 2026-07-02

> Scope: `@glubean/sdk` republish only (F31). Other packages stay at their current published versions; `@glubean/cli` had already moved ahead independently (0.8.3). Published manually via `pnpm --filter @glubean/sdk publish` — the `v*` tag workflow is intentionally NOT used here, because its final gate verifies all 13 packages at the tag version and would go red on a single-package release.

### Fixed
- **F31 — zod contracts now emit real JSON Schema** (`@glubean/sdk`) — `schemaToJsonSchema` tested `"type" in schema` *before* trying the schema's own `toJSONSchema()`. Zod v4 instances expose a `type` getter, so zod schemas were misclassified as already-plain JSON Schema and their raw internals (`def`, `checks`, `shape`, `format: null`) leaked verbatim into the contract projection and the generated OpenAPI document — downstream consumers (MCP `glubean_openapi`, the designer) rendered empty/garbage objects. The `toJSONSchema()` conversion now runs first, and the per-document `$schema` key zod emits is stripped (OpenAPI 3.1 pins the dialect at the document level). Unrepresentable schemas (`z.date()`, `z.bigint()`, transforms) still throw and land in `unprojectableSchemas`, so dry-run/sync keep reporting the hole.

### Added (sdk authoring/API surface riding along from `main` since 0.8.1)

These land in the published `@glubean/sdk` because 0.8.2 is cut from `main`; the matching runner/CLI runtime support is on `main` but NOT yet in any published `@glubean/runner`/`@glubean/cli` (the last CLI publish, 0.8.3, predates them — 2026-06-27).

- **`ctx.when` / `ctx.switch` / `ctx.while` authoring API + projection support** (`@glubean/sdk`) — test-shape dry-run projection of conditional test bodies.
- **`ctx.http.track(pattern)`** (`@glubean/sdk`) — pin a raw HTTP call to its canonical endpoint.
- **`{id, rowIndex}` "only" selector protocol, sdk side** — the CLI flags `--only-id`/`--row`/`--rerun-failed` ship with the next `@glubean/cli` release.

---

## [0.8.1] — 2026-06-24

### Fixed
- **`@glubean/runner` missing from init templates** — `@glubean/runner` was absent as a direct `devDependency` in the `minimal` and `demo` project templates generated by `glubean init`, causing a missing-module error on first run in fresh projects. (#7)
- **Session tests no longer depend on httpbin.org** — replaced the external `httpbin.org` dependency in session integration tests with a local echo server, eliminating intermittent CI failures caused by httpbin.org outages.

---

## [0.8.0] — 2026-06-21

### Added

#### Load testing (`glubean load`) — new command and `@glubean/sdk/load` subpath
- **`glubean load` CLI command** — discover load plans in a project, run them via a subprocess, and write structured artifacts. Includes threshold evaluation and a summary display.
- **`@glubean/sdk/load` authoring types** — `loadScenario()`, `loadRunner()`, traffic-mix (`weighted`), `each` (data-driven scenarios), `feeder` (shared data pools), and type-safe plan projection.
- **Load artifact format** (`glubean.load.v1`) — structured output covering overall stats, per-endpoint metrics, per-scenario breakdowns, timeline, failure/slow-transaction samples, and threshold results.
- **Latency distribution histograms** — fixed-ladder histogram capturing p50/p75/p90/p95/p99 per endpoint and overall.
- **Over-time timeline** — RPS, latency, error rate, and concurrency tracked across the run at fixed-window resolution.
- **Traffic-mix execution** — multi-scenario runs with weighted concurrency allocation.
- **Failure-trace and slow-transaction samples** — representative samples of failing and slow iterations, capped per endpoint.
- **Continuation pool (`M6`)** — async continuations (long-poll, polling patterns) isolated in a bounded pool; producer release tracked via a state-machine lifecycle. CLI shows primary vs end-to-end phase split and run-shape advisories.
- **Exact `routeKey` from contract route templates (`M8`)** — when load plans reference `contract.http()` cases, the exact parameterized path pattern (`GET /users/:id`) is used for aggregation instead of a URL heuristic.
- **Subprocess execution** — load plans run in a child process using the project-local SDK install, eliminating SDK version split-brain between the CLI and the user's project.
- **Heuristic `routeKey` normalization** — collapses numeric/UUID-shaped path segments to `:id` placeholders for aggregation when no contract template is available.

#### Engine / runner
- **Real mid-run abort** (`ScopeInput.signal`) — the load runner can now abort cleanly mid-run via an `AbortSignal` threaded through the engine scope.
- **`ctxExtensions` hook** — generic per-run context extension point added to the engine core.

### Fixed
- **Leak-free per-iteration abort bridge** — the previous implementation registered a new `abort` event listener for every iteration without cleanup, causing O(iterations) listener accumulation. Now uses a single shared bridge with precise teardown. Default mode (`abort:"precise"`) recovers ~2.5× throughput; opt-in `abort:"coarse"` mode recovers ~3×.

---

## [0.7.0] — 2026-06-18

### Added

#### `@glubean/engine` — new package
- **Environment-agnostic run-loop core** shared by the Node runner and the browser Playground host. Replaces the duplicated execution logic that previously existed in both.
- **Steps run-loop** — `step_start`/`step_end` events with per-step `stepIndex`, retry, and timeout (`Phase 1a/b`).
- **Branch steps** — `condition`, `switchOn`, `switchCond` (`Phase 2`).
- **Poll steps** — `runPollStep` + `poll` event (`Phase 3`).
- **Full ctx surface** — `ctx.skip`, `ctx.fail`, `ctx.validate`, `ctx.metric`, `ctx.action`, `ctx.event`, `ctx.trace`, `ctx.setTimeout`, `ctx.pollUntil` (`Phase 4a–f`).
- **Full-trace capture via ky** — request/response headers, bodies, schema validation, truncation (`Phase 4f`).
- **Cutover mechanism** — route-all wildcard + `workflow`/`contract` exclusion + `session.require/entries` support (`Phase 8a`).
- **Engine on by default** — all simple-test runs now go through `@glubean/engine` (`Phase 8b`).
- **Browser safety guardrail** — build-gate and real-Chrome smoke test assert the engine bundle excludes Node-only APIs.

#### Workflow executor
- **Relocated from `@glubean/sdk` to `@glubean/runner`** — the workflow executor now lives in the runner package, clarifying the boundary: SDK authors the plan; runner executes it.
- **Invocation inverted** — the host (runner) now calls `runWorkflow(executor, plan)` instead of the SDK wrapper driving the executor, removing the circular dependency.

#### CLI / scanner
- **`glubean login`** — browser-based device authorization flow (RFC 8628). Opens the system browser, polls for a token, and stores it under `~/.glubean/`.
- **Lockstep release policy documented in CI** — `publish.yml` now verifies npm state before publishing and the policy is recorded in `CLAUDE.md`.

### Changed
- **ky 1 → 2** across `sdk`, `runner`, `auth`, `oauth-code` — updated hooks API (`beforeRequest`/`afterResponse`), trace keying, and `prefixUrl` handling.
- **Node ≥ 22 floor** declared in `engines` (was ≥ 18).

### Fixed
- `vars.all()` returned a fallback-proxy spread instead of the raw vars map.
- `ctx` accessor surface completed — `vars.all()` + `getMemoryUsage()`.
- Engine `resolve()` propagates `skip`/`only`; `run()` honors `skip`.
- Forward `trace`/`action`/`event` through `scope.runtime` for plugins.
- GraphQL and gRPC workflows now driven via `runWorkflow` (was ad-hoc direct calls).

---

## Older versions

Changes prior to `v0.7.0` are not captured in this CHANGELOG. Use `git log v0.2.10..v0.7.0` to browse the history, which covers:
- `v0.6.x` — contract projections, full upload (Design Y), redaction hardening, `.workflow.ts` extension, `v0.6.0` SDK cleanup (delete legacy `contract.flow`).
- `v0.3.x`–`v0.5.x` — config profiles, multi-suite, `--ci` flag, demo template, per-profile multi-project upload.
- `v0.2.x` — initial Node.js port from Deno; `@glubean/engine` spike, inbound contract receivers, workflow vNext (S2 series).

[Unreleased]: https://github.com/glubean/glubean/compare/v0.8.4...HEAD
[0.8.4]: https://github.com/glubean/glubean/compare/v0.8.1...v0.8.4
[0.8.2]: https://github.com/glubean/glubean/compare/v0.8.1...5db5384
[0.8.1]: https://github.com/glubean/glubean/compare/v0.7.0...v0.8.1
[0.8.0]: https://github.com/glubean/glubean/compare/v0.7.0...8ecde8e
[0.7.0]: https://github.com/glubean/glubean/compare/v0.2.10...v0.7.0
