# Changelog

All notable changes to the Glubean SDK and CLI packages are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [lockstep semver](./CLAUDE.md#version-policy) — all packages share one version number.

---

## [Unreleased]

### Added
- **Unpacked Chrome extension testing in `@glubean/browser`** (#19) — launch one or more extension directories with `browser({ launch: true, extensions })`; discover loaded extensions, workers, pages, and targets through `@glubean/browser/chrome-extension`; trigger real toolbar actions; verify native Side Panel open/close behavior; and test options pages and content scripts with dedicated guides and a real-Chrome smoke test. Extension-origin absolute URLs now remain intact when an application `baseUrl` is configured. Native Side Panel closing requires Chrome 141+.
- **Pipe-transport attach failures are explicit in `@glubean/browser`** — `GlubeanBrowser.wsEndpoint()` now throws a descriptive error when Chrome has no CDP WebSocket endpoint, including extension-enabled sessions, instead of returning an unusable empty string.

### Changed
- **BREAKING: `@glubean/browser` now requires `puppeteer-core >=24.41.0 <26`** — Chrome extension discovery and toolbar actions use Puppeteer's high-level `Extension` API introduced in 24.41. Existing browser-plugin users on Puppeteer 22 or 23 must upgrade before installing this release.

## [0.10.3] — 2026-07-11

### Changed
- **HTTP contract case `params` renamed to `pathParams`; `params` is now a deprecated alias** (`@glubean/sdk`) — the field only ever fills the endpoint's `:key` PATH segments (`pathParams: { id: "u_1" }` + `GET /users/:id` → `GET /users/u_1`), never the query string, and the bare name `params` hid that. `pathParams` is the canonical name (same type, static or `(input: Needs) => ...` function form, `ParamValue` metadata included); `params` keeps working with a `@deprecated` JSDoc marker until a future major. Setting both on one case throws at contract construction; inbound cases reject `pathParams` exactly like `params`. Projection wire format is unchanged (`schemas.params`), so Cloud/CLI/MCP/OpenAPI consumers are unaffected. `glubean init` templates, test-project fixtures, and the authoring skill docs now use `pathParams`.

## [0.10.2] — 2026-07-10

### Added
- **Contract source capture — the authored declaration ships with the projection** (`@glubean/scanner`, `@glubean/cli`) — `glubean sync` captures each contract's `export const … = contract.…(…)` span verbatim (AST slice by EXPORT name, so scoped factories like `platformContract(...)` are covered — incl. multi-declarator statements per declarator, same-file `export { x as y }` aliases, and `export default` with TS wrappers like `satisfies` unwrapped) and attaches it to the uploaded projection as `sourceText`. Cloud's Specs view renders it as a per-contract "Source" disclosure, so reviewers see the `verify()` logic a data projection can't express. Deliberately published verbatim: keep secrets in env vars / out-of-span consts, never inlined in a contract (skill rule 22); the structured projection stays redacted exactly as before (pinned by test).
- Boundaries & budgets for source capture: cross-file re-exports and symlinks escaping the project root fail CLOSED (no source captured); 64 KiB per-contract capture cap with an explicit `sourceTextOmitted` marker (never silent); the sync payload budget vs the platform's 8 MiB body cap is all-or-nothing (a large project can always sync, and an unchanged contract's revision hash never churns because a *neighbor* grew); `glubean_extract_contracts` MCP responses strip `sourceText` (the server runs locally — consumers read source from disk; `sourceFile`/`line` remain).

## [0.10.1] — 2026-07-09

### Added
- **`glubean load --profile` runs a named load plan from config** (`@glubean/cli`, GLU-244) — `glubean load --profile <name>` resolves and runs a load plan declared in the glubean config instead of assembling capacity runs from ad-hoc CLI args, so configured load runs are repeatable from one flag. Hardening (codex R1–R5): `--config` is threaded through bare `load --upload` too, a missing *explicit* `--config` is now fatal rather than a silent fallback, plus a precise `envFileExplicit` flag and target-drop condition.

## [0.10.0] — 2026-07-07

### Added
- **Structured session/cookie/header behavior + per-node assertions on workflow nodes** (`@glubean/sdk`, GLU-195) — the workflow-node projection schema gains author-declared `session` (cookie/header names + a coarse establish/refresh/read/revoke lifecycle badge) and `verify` (structured per-node assertion rows) hints, so the Specs workflow inspector can render them first-class instead of parsing free-text `reads`. All fields are optional and backward-compatible; cookie/header NAMES are validated against RFC-7230 token grammar (so a value can't be smuggled) and stay redaction-safe (names survive sync, real cookie values still mask — GLU-123 intact).

### Fixed
- **Redact query secrets embedded in raw-string network-error messages** (`@glubean/redaction`, GLU-214) — ky's `NetworkError.message` embeds the full request URL verbatim on a connection failure, so a custom-string secret riding as a query value (e.g. `?custom_secret=abc`) leaked in plaintext into `--log-file`, because the raw-string handler only ran whole-string pattern matching (bearer/jwt/ip/hex). It now finds embedded `http(s)://` URLs in the text and runs them through the same by-key query redaction as the url-query handler before the pattern scan.
- **All-broken discovery-failure runs now flow through the full result/junit/upload pipeline** (`@glubean/cli`, GLU-194, GLU-155 follow-up) — when *every* targeted contract/test file failed to import, `glubean run` took an early-exit branch that persisted only `last-run.result.json` and skipped `--result-json`, `--reporter junit`, and `--upload` (unlike a mixed run where some files import). The "0 tests to run" exits are now gated behind an `allBrokenDiscovery` flag so an all-broken run still writes reporters and uploads status `failed`; a genuinely empty run (no import failures) keeps its prior exit-without-pipeline behavior.

---

## [0.9.5] — 2026-07-04

### Fixed
- **`{{ENV}}` placeholders in contract HTTP path/query params now resolve before encoding** (`@glubean/sdk`, GLU-156) — case params such as `params: { projectId: { value: "{{GLUBEAN_PROJECT_ID}}" } }` were previously URL-encoded verbatim (producing a literal `%7B%7B...%7D%7D` in the request path — a 404 — instead of the real value). `extractParamValue` now resolves `{{KEY}}` through the same `configure()` template resolver used by headers/query/body; resolution happens before per-segment `encodeURIComponent`, so a resolved value with reserved characters is still percent-encoded correctly.
- **A contract/test file that throws on import now fails the run instead of silently reporting zero tests** (`@glubean/cli`, GLU-155) — `discoverTests()` previously swallowed import failures by returning `[]`, indistinguishable from a file that legitimately exports no tests; the run kept going and exited 0 while an entire file never ran. Import failures are now recorded, surfaced as a "Discovery: N file(s) failed to import" summary line, and the run exits non-zero and uploads as `failed`; `--rerun-failed` can retry the import-failed file.

---

## [0.9.4] — 2026-07-04

### Fixed
- **`glubean sync`/`--upload` auto-derive the Platform ingest host from `GLUBEAN_API_URL`; `--api-url` is now hidden from `--help`** (`@glubean/cli`, GLU-161) — users who only set `GLUBEAN_API_URL` (their Dashboard host) got a 404 on every `sync`/upload/login call, because those commands actually need a separate Platform API host. `resolveApiUrl()` now auto-derives the Platform host by swapping the `api.` subdomain label for `platform.`; `--api-url`/`GLUBEAN_PLATFORM_API_URL` remain as internal, hidden overrides for hosts the derivation can't cover, and an unresolvable host now prints a remediation hint and exits 1 instead of silently guessing. `DEFAULT_API_URL` is corrected from `api.glubean.com` (404s on `/v1/*`) to `platform.glubean.com`.
- **Runtime `ctx.skip(reason)` now reaches the persisted/uploaded result** (`@glubean/runner`, `@glubean/cli`, `@glubean/redaction`, GLU-142) — a test's actual runtime skip reason never made it past the harness wire event, so the dashboard could only ever show a spec's *declared* skip reason, never the real one a given run carried. `ExecutionResult.reason` and the uploaded `test_result` row now carry it through, redacted the same as `status.error`/`status.stack`.
- **`glubean_list_test_files` (MCP) now includes contract/workflow coverage files, not just `test()` files** (`@glubean/mcp`, GLU-140) — in a contract-first project, the tool previously returned only files with `test()` exports, silently omitting `*.contract.ts`/`*.flow.ts`/`*.workflow.ts` — the files where the project's actual runnable coverage lives — which could push an agent toward `test()`-first behavior.
- **Screenshot cleanup warning wording** (`@glubean/cli`, GLU-138) — the post-upload warning duplicated "screenshot list screenshot file(s)" and buried the skip reason inside an awkward count phrase; reworded to state the total skipped count up front with reasons listed parenthetically (no behavior change).

---

## [0.9.3] — 2026-07-03

### Fixed
- **MCP/redaction — residual plaintext-secret leaks closed (R11–R16)** (`@glubean/mcp`, `@glubean/redaction`, GLU-129 follow-up) — a verification-debt re-run after 0.9.2 found 3 residual leak shapes: tuple-form entries (`["token", "secret"]`, the shape `Object.entries()`/header pairs produce — the array walker never checked element 0 as a key), form-urlencoded string literals inside SDK assertion messages, and bare form-urlencoded message strings that bypassed the scrubber loop. Also fixed 2 over-masking regressions (double-masking), gated via `looksLikeFormUrlEncoded`. Converged to 3 consecutive rounds with 0 leaks found.
- **Reject Windows drive-relative/absolute projection paths** (`@glubean/cli`, GLU-143) — `assertContainedRelativePath` validated paths with POSIX-only semantics, so a Windows drive-relative value like `C:outside.json` (and other Windows-only escape forms — `\outside`, UNC paths, backslash `..` escapes) could pass containment checks meant to keep `projections.contracts.<name>.output`/`target` inside the project root. Paths are now validated under both POSIX and Windows semantics.
- **`trace.routeKey` now stamped for standalone/workflow runs, not just load runs** (`@glubean/runner`, GLU-148) — `contract.http()` case execution already set `context.glubeanRoute` and the load runner's engine read it back into `trace.routeKey`, but a normal `glubean run` (standalone contract cases and workflow `.call()` steps) executes through the separate legacy harness, whose `afterResponse` hook never read `context.glubeanRoute` — so `trace.routeKey` was never stamped outside load runs.

---

## [0.9.2] — 2026-07-02

### Fixed
- **MCP local-debug tools redact assertion/log/status/error/warning events, not just trace** (`@glubean/mcp`, `@glubean/redaction`, GLU-129) — `glubean_run_local_file` / `glubean_get_local_events` still returned plaintext secrets embedded in non-trace event fields, closing the leak class that survived GLU-104 (10 codex xhigh rounds; round 11 was deferred to the following release as recorded verification debt — see 0.9.3).
- **MCP `open*` cloud tools prefer `GLUBEAN_PLATFORM_API_URL` over legacy `GLUBEAN_API_URL`** (`@glubean/mcp`, GLU-139) — the ingest tools need the Platform host, not the Dashboard host that `GLUBEAN_API_URL` typically points at (the CLI-side counterpart shipped later in 0.9.4 / GLU-161).
- **Discovery resolves tags inherited from `contract.http.with()` defaults** (`@glubean/mcp`, GLU-130) — tags applied via a contract's `.with()` defaults were dropped during discovery; a shared tag-resolution helper now gives runtime and static-fallback the same result.
- **Result JSON `summary.stats` derived from per-test events** (`@glubean/cli`, GLU-128) — the persisted summary stats are now computed from the emitted per-test events rather than a separate accounting path that could drift.

### Added
- **Hoist reusable OpenAPI body schemas into `components.schemas`** (`@glubean/sdk`, GLU-127) — repeated request/response body schemas are lifted into `components.schemas` and referenced, instead of being inlined at every operation.

---

## [0.9.1] — 2026-07-03

### Fixed
- **Redaction — MCP trace output leaked auth headers/cookies/body/gRPC** (`@glubean/mcp`, `@glubean/redaction`, GLU-104) — auth headers, cookies, and request/response bodies in MCP trace output were returned in cleartext; hardened over multiple codex rounds (credential-key aliases, malformed/array `set-cookie`, JSON-as-string bodies, relative-URL query, cyclic-input guard, target/name query params, URL fragments).
- **CLI local disk writes bypassed event redaction** (`@glubean/cli`, `@glubean/redaction`, GLU-105) — disk-writing sinks (not just `--upload`) are now routed through the same event redaction, non-event result fields are scrubbed before local disk writes, and browser download evidence URLs are redacted.
- **`glubean sync` projection redaction leaked cookie/session-id in cleartext** (`@glubean/cli`, `@glubean/redaction`, GLU-123) — projection upload masked cookie/session-id values, and boolean JSON-Schema nodes under sensitive keys are preserved.
- **OpenAPI merge dropped operations on method+path collisions** (`@glubean/sdk`, GLU-116) — colliding operations are preserved (relocated to a vendor extension) instead of being silently dropped; every operation is now always kept.
- **Normalize OpenAPI path keys to always start with `/`** (`@glubean/sdk`, GLU-119).
- **Support Zod v4 static `toJSONSchema` fallback** (`@glubean/sdk`, GLU-120) — Zod v4 request/response schemas were lost during projection.
- **`glubean init` no longer resolves `npm test` to a stale global CLI** (`@glubean/cli`, GLU-110 / GitHub #9) — all three scaffold templates (standard, `--contract-first`, `--template demo`) now list `@glubean/cli` as a direct `dependencies` entry, same as `@glubean/runner`. Without it, `node_modules/.bin` had no local `glubean` binary, so the bare `glubean` in generated `npm test`/`npm run test:ci` scripts silently fell back to whatever `glubean` happened to be on the machine's global PATH — commonly a much older version that doesn't recognize current flags (e.g. `error: unknown option '--profile'`). The generated CI workflow template's `npx glubean ci run` was not a safe substitute either — without a local `node_modules/.bin/glubean`, `npx` resolution is not guaranteed to avoid a stale global — so adding the CLI as a direct dependency (which both invocation styles resolve to first) was the fix, not a script-only rewrite.
- **CLI upload preflight 404 on a trailing-slash `--api-url`/`GLUBEAN_API_URL`** (`@glubean/cli`, GLU-109 / GitHub #8) — trailing-slash API URLs are normalized in both the preflight and the real POST.
- **`glubean init` standard template missing `zod` dependency** (`@glubean/cli`, GLU-114).
- **`configure()` JSDoc used a bare key instead of `{{key}}` template syntax** (`@glubean/sdk`, GLU-115).
- **`demo` init template gitignore now ignores generated `result.json`** (`@glubean/cli`, GLU-121).

### Added
- **Contract projection outputs can be declared in `glubean.yaml`** (`@glubean/cli`, `@glubean/sdk`, GLU-117) — with path-containment validation so a projection output stays inside the project root.

---

## [0.9.0] — 2026-07-03

### Added
- **BT1-M4 browser capabilities** (`@glubean/browser`, GLU-70) — `storageState`, dialog handling, popup/`waitForPopup`, `nth`/`count`, `expectChecked`/`expectValue`, and `userAgent`.
- **BT1-M5 tail browser capabilities** (`@glubean/browser`, GLU-71) — iframe and download support.
- **`test.each` row-key metadata** (`@glubean/sdk`, B3-T1) — `idTemplate` + reorder-stable `rowKey` on all three registration paths, ride the projection upload (collision-safe shared template tokenizer, word-boundary `$index`).
- **Runtime emit of `.each` row identity on the run-events channel** (`@glubean/runner`, `@glubean/engine`, `@glubean/cli`, B3-T3, GLU-75).
- **Custom metrics authoring** (`@glubean/sdk/load`) — `rate()`, `trend()`, `counter()` metric builders for user-defined load signals (`A1`).
- **Custom metrics fold + gate thresholds** (`@glubean/runner`) — custom metric values are folded into the load artifact alongside built-in metrics; threshold evaluation supports custom metric names (`A2`).

### Changed
- **60 Dependabot security vulnerabilities resolved** (GLU-78) — via root pnpm `overrides` (hono, `@hono/node-server`, protobufjs, basic-ftp, fast-uri, lodash, path-to-regexp, ws, qs, ip-address, brace-expansion, picomatch, postcss, vite) plus direct bumps (vitest, `@grpc/grpc-js`, tsx).

### Fixed
- **Preserve sticky-regex anchoring in mock URL matching** (`@glubean/browser`, GLU-73) — the `EvidenceSession` Fetch mock lost anchoring for sticky-regex URL patterns.
- **Project hand-rolled `SchemaLike` response schemas via the `jsonSchema` hint** (`@glubean/sdk`, `@glubean/graphql`, `@glubean/grpc`, GLU-90) — hand-rolled response schemas across HTTP/GraphQL/gRPC now project instead of being dropped.
- **Engine captures a clean pre-absolutization relative URL for worker reanchor** (`@glubean/engine`, GLU-81).
- **B2-M3 run-selector edges** (`@glubean/cli`, GLU-67) — `--only-id` keeps all matching exports, and rerun/capability-skip ordering no longer produces spurious skips outside the failed set.
- **Refuse to silently load a prod-like active-env** (`@glubean/cli`, GLU-88) — the CLI no longer silently defaults to a production-looking active environment.
- **Widen spawn-test timeouts to stop load-induced flakes** (`@glubean/runner`, `@glubean/cli`, GLU-79) — test-infra only, no product runtime change; fixes flakes that reddened release CI under parallel load.

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

[Unreleased]: https://github.com/glubean/glubean/compare/v0.9.5...HEAD
[0.9.5]: https://github.com/glubean/glubean/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/glubean/glubean/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/glubean/glubean/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/glubean/glubean/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/glubean/glubean/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/glubean/glubean/compare/v0.8.4...v0.9.0
[0.8.4]: https://github.com/glubean/glubean/compare/v0.8.1...v0.8.4
[0.8.2]: https://github.com/glubean/glubean/compare/v0.8.1...5db5384
[0.8.1]: https://github.com/glubean/glubean/compare/v0.7.0...v0.8.1
[0.8.0]: https://github.com/glubean/glubean/compare/v0.7.0...8ecde8e
[0.7.0]: https://github.com/glubean/glubean/compare/v0.2.10...v0.7.0
