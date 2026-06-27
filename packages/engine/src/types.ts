/**
 * @glubean/engine (Stage 1 spike) — environment-agnostic run-loop core.
 *
 * Lives in packages/engine during the isolation gate; both hosts reference it:
 * @glubean/runner (NodeHost) and lite's BrowserHost. Hosts implement the ports
 * and drive RunnerCore; the run-loop semantics live here, written once.
 *
 * HTTP architecture (Decision B, codex-reviewed): run REAL ky in BOTH hosts. The
 * host seam is the web-standard `fetch`; the engine builds a per-run ky instance
 * with the injected fetch + scope-bound trace hooks and exposes it as
 * `scope.runtime.http`. ky (extend/hooks/retry/timeout/configure().http) is then
 * shared, written once — no hand-rolled HttpFacade.
 *
 * Stage 1 goal (headline go/no-go): prove per-run isolation is delegated entirely
 * to the injected Carrier port via an explicit ExecutionScope, with NO module-
 * global coupling. Narrow run-loop only (simple / linear steps); branch / poll /
 * retry / timeout / workflow are Stage 2.
 */
import type { KyInstance, Options } from "ky";
import type { InternalRuntime, RuntimeCarrier } from "@glubean/sdk/internal";
import type { GlubeanAction, GlubeanEvent, HttpSchemaOptions, MetricOptions, PollUntilOptions, SchemaIssue, SchemaLike, SwitchCase, Trace, ValidateOptions } from "@glubean/sdk";

/** ky request options plus Glubean's retained public `prefixUrl` (the engine maps
 *  it to ky 2's `prefix` at the boundary) and the `schema` option for automatic
 *  request/response validation (node parity: harness KyOptionsWithSchema). */
export type GlubeanHttpOptions = Options & { prefixUrl?: string; schema?: HttpSchemaOptions };

/**
 * The http client both hosts expose as `ctx.http` / `runtime.http`: a ky instance
 * whose call / method / `.extend()` options also accept the public `prefixUrl`
 * (codex P2-3 — typing it as raw KyInstance would reject `extend({ prefixUrl })`
 * at compile time even though the runtime proxy maps it).
 */
type KyResponsePromise = ReturnType<KyInstance["get"]>;
export interface GlubeanHttp {
  (url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  get(url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  post(url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  put(url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  patch(url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  delete(url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  head(url: string | URL | Request, options?: GlubeanHttpOptions): KyResponsePromise;
  extend(options: GlubeanHttpOptions | ((parentOptions: Options) => GlubeanHttpOptions)): GlubeanHttp;
}

/**
 * Host port: the only HTTP egress, as the web-standard `fetch`. node = node fetch
 * (undici) / browser = a fetch wrapping the CORS-bypass extension or direct fetch.
 * The browser wrapper MUST honor the real fetch contract (Request/URL + init,
 * AbortSignal, clone-before-read) — see fetch-conformance tests. (codex P1-3)
 */
export type FetchImpl = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** Host port: vars are available everywhere; secrets are node-only (never browser). */
export interface EnvProvider {
  vars(): Record<string, string>;
  secrets(): Record<string, string>;
  /** Optional RAW vars snapshot for ctx.vars.all() (node parity: {...rawVars}). The
   *  `vars()` accessor a host returns may be a fallback Proxy (.env→process.env) whose
   *  spread would resolve empty values to the fallback / drop them; varsAll() returns
   *  the un-proxied map so all() matches legacy exactly. Falls back to spreading vars()
   *  when absent (codex Phase-8 P2). */
  varsAll?(): Record<string, string>;
}

// Every event carries the owning test `id` so a host running runs concurrently
// can attribute assertion/trace/log events to the right run (codex P2-2).
export type ExecutionEvent =
  | { type: "start"; id: string; name: string; tags: string[]; retryCount?: number }
  | { type: "assertion"; id: string; passed: boolean; message?: string; actual?: unknown; expected?: unknown; stepIndex?: number }
  // ctx.trace + the HTTP auto-trace carry the FULL Trace shape (node parity:
  // harness.ts:767 / :1043) — not a flat {method,url,status,timeMs}. ctx.trace ALSO
  // emits a derived `action`; the HTTP auto-trace ALSO emits an http_duration_ms metric.
  | { type: "trace"; id: string; data: Trace; stepIndex?: number }
  | { type: "log"; id: string; message: string; data?: unknown; stepIndex?: number }
  | { type: "warning"; id: string; condition: boolean; message: string; stepIndex?: number }
  // ctx.validate / HTTP schema hooks — first-class (node parity: emitted regardless
  // of success/severity; a failure ALSO routes through assert/warn per severity).
  | { type: "schema_validation"; id: string; label: string; success: boolean; severity: "error" | "warn" | "fatal"; issues?: SchemaIssue[]; stepIndex?: number }
  // ctx.metric — numeric perf metric (node parity: harness.ts:818).
  | { type: "metric"; id: string; name: string; value: number; unit?: string; tags?: Record<string, string>; stepIndex?: number }
  // ctx.action — typed interaction record (node parity: harness.ts:790). ctx.trace
  // ALSO emits a derived action (Phase 4f).
  | { type: "action"; id: string; data: GlubeanAction; stepIndex?: number }
  // ctx.event — generic structured event (node parity: harness.ts:804). The workflow
  // first-class unwrap (workflowEventToTimeline) is workflow-only → stays node-legacy
  // (workflow tests are never engine-routed), so the engine always emits generic.
  | { type: "event"; id: string; data: GlubeanEvent; stepIndex?: number }
  | { type: "step_start"; id: string; index: number; name: string; total: number; group?: string }
  | {
      type: "step_end";
      id: string;
      index: number;
      name: string;
      status: "passed" | "failed" | "skipped";
      durationMs: number;
      assertions: number;
      failedAssertions: number;
      // present for run steps; omitted for steps skipped after an earlier failure
      // (node parity: emitSkippedTree emits no attempts/retriesUsed)
      attempts?: number;
      retriesUsed?: number;
      error?: string;
      returnState?: unknown;
      // Group label (host-set, e.g. the SDK builder's `.group()`) — also on
      // step_end so a SKIPPED leaf (which emits no step_start) keeps attribution.
      group?: string;
    }
  | {
      type: "branch";
      id: string;
      index: number;
      name: string;
      takenIndex: number | "default";
      takenValue?: string | number | boolean | null;
      message?: string;
      total: number;
      error?: string;
    }
  // test().poll — a bounded retry leaf step (node parity: harness.ts:2490). Emitted
  // alongside the step's step_start/step_end. `index` is the leaf step index.
  | { type: "poll"; id: string; index: number; name: string; attempts: number; elapsedMs: number; satisfied: boolean; exhausted: boolean; error?: string }
  // ctx.setTimeout — a CONTROL event (not a timeline event): the node parent re-arms
  // its SIGTERM deadline (node parity: harness.ts:898 / executor.ts:1083). The host
  // bypasses event buffering for it (CONTROL_EVENT_TYPES), like session_set.
  | { type: "timeout_update"; id: string; timeout: number }
  // ctx.session.set — a host may surface this as a control signal (the node runner
  // forwards it to sibling tests; the browser updates its session store).
  | { type: "session_set"; id: string; key: string; value: unknown }
  | { type: "status"; id: string; status: "ok" | "error" | "skipped"; error?: string };

/** Host port: where execution events go. node = stdout stream / browser = collector. */
export interface EventSink {
  emit(e: ExecutionEvent): void;
}

/** Host port: clock / timers. Stage 1 uses now() only (trace timing). */
export interface Scheduler {
  now(): number;
}

/**
 * Host ports wired in Stage 1. `carrier` is the SDK RuntimeCarrier the engine
 * installs so getRuntime() consumers (configure() / session / configured-http)
 * resolve to the active scope's runtime. node provides an ALS carrier (true
 * cross-await isolation); browser provides its own (single-flight today,
 * AsyncContext-style propagation later — an open decision, not this gate).
 */
export interface RunnerServices {
  fetch: FetchImpl;
  env: EnvProvider;
  events: EventSink;
  scheduler: Scheduler;
  carrier: RuntimeCarrier;
  /** HTTP trace policy (host-injected from ExecutorOptions, all default OFF): full
   *  request/response capture, response-body schema inference, and aggressive array
   *  truncation. Node parity: harness emitFullTrace / inferSchema / truncateArrays. */
  http?: {
    emitFullTrace?: boolean;
    inferSchema?: boolean;
    truncateArrays?: boolean;
    /** How a run-level abort signal reaches in-flight HTTP requests.
     *  - "precise" (default): hand a per-iteration AbortSignal to ky so an aborted run
     *    cancels its in-flight requests at once. Exactly ONE listener is added to the
     *    long-lived run signal per iteration and removed when the iteration settles — no
     *    per-request listener accumulation (the load-throughput footgun that otherwise
     *    makes a long run get progressively slower).
     *  - "coarse": never wire the run signal into ky; rely on the engine's between-step
     *    `signal.aborted` checks instead. Drops in-flight cancellation for a few % more
     *    throughput — for high-RPS load where requests are short. */
    abortMode?: "precise" | "coarse";
  };
}

// --- type sketches only (Stage 1 P3-1: NOT implemented/wired; here to fix the
//     seam so the gate stays inside the isolation-only box). Use them when needed.
export interface ModuleLoader {
  provide(source: string): Promise<Record<string, unknown>>;
}
export interface DataProvider {
  read(name: string): Promise<string>;
}
export interface FeaturePolicy {
  supports(feature: string): boolean;
}

/** Per-run runtime input (vars/secrets/session) layered over the host EnvProvider. */
export interface ScopeInput {
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  session?: Record<string, unknown>;
  /** Test-level retry attempt (the host re-runs a failed test); surfaced on
   *  ctx.retryCount + the start event, like the node harness. 0/undefined = first run. */
  retryCount?: number;
  /**
   * Abort the run mid-flight. The engine hands this to ky (so an in-flight HTTP request
   * is cancelled) and checks it between steps + during its own waits (poll interval,
   * retry backoff, ctx.pollUntil), so an aborted run stops promptly instead of running
   * its residual poll/HTTP to completion. Errors from an aborted request surface as a
   * caught step/poll failure (the run still resolves a TestResult — it never rejects).
   * Used by the load runner to truly kill continuation tails the drain phase abandons;
   * arbitrary opaque user async (a bare `setTimeout`) cannot be cancelled.
   */
  signal?: AbortSignal;
  /**
   * Host-provided extra ctx fields, merged onto the per-run ctx (e.g. a load
   * runner adding `input` / `report` / `producerSlot` / `iteration`). The engine
   * does NOT interpret these and only ADDS keys not already on the ctx — built-in
   * members are never overridden — so host-defined step APIs can read them
   * without the engine knowing their meaning.
   */
  ctxExtensions?: Record<string, unknown>;
}

export interface TestResult {
  id: string;
  name: string;
  /** The engine's verdict: "error" if it threw OR a soft assertion failed. */
  status: "ok" | "error" | "skipped";
  /** True only if user code threw (vs a soft assertion failure). Lets a host
   *  distinguish "completed but failed an assertion" from "threw" when deciding
   *  status/exit semantics (the runner re-raises a throw; a soft fail completed). */
  threw?: boolean;
  /** True if a STEP failed (assertion or throw) in a steps run. Node parity: a
   *  steps test with any failed step is reported as a failure ("One or more steps
   *  failed"), unlike a simple test's soft assertion failure which "completes". */
  stepsFailed?: boolean;
  /** The message a host should throw for `stepsFailed` — usually "One or more steps
   *  failed", or a branch-decision-specific message when a branch decision failed. */
  stepsFailMessage?: string;
  /** When `status === "skipped"` because user code called ctx.skip(reason?): the
   *  reason. A host re-raises its own SkipError(reason) so the dispatcher emits the
   *  same skipped status (with `reason`) as the legacy path (plan 0005 / codex). */
  skipReason?: string;
  error?: string;
  /** The original throw's stack (only when `threw`), so a host can re-raise with
   *  the user's stack instead of a host-rooted one (diagnostics parity). */
  errorStack?: string;
  /** The original throw's error name (e.g. "TypeError", ky's "TimeoutError"), so a
   *  host can re-raise with it and keep failure classification (diagnostics parity). */
  errorName?: string;
  /** The first CAUGHT step/poll failure's error name (set only when the run did NOT
   *  throw at the top level). A host classifies a step-level failure with it — e.g.
   *  the load runner mapping ky's "TimeoutError" / "HTTPError" / "StepTimeoutError"
   *  to a load errorKind — since `errorName` carries only top-level throws. */
  stepErrorName?: string;
  assertions: { total: number; passed: number };
}

export type TestFn = (ctx: EngineContext, state?: unknown) => unknown | Promise<unknown>;
export interface StepDef {
  meta: {
    name: string;
    /** Logical group label — emitted on this step's `step_start` for report
     *  grouping. Host-set (e.g. the SDK builder's `.group()`); the engine only
     *  forwards it. */
    group?: string;
    /** When true, a failure caused ONLY by soft assertions (no throw) records the
     *  failure + marks the test failed but does NOT skip the remaining steps. A
     *  thrown step still halts. Default (false) = fail-fast on any step failure
     *  (node parity). Host-set (e.g. the load runner's `continue` assertion
     *  policy); the engine stays unaware of what the policy means. */
    continueOnAssertionFailure?: boolean;
  };
  fn: TestFn;
}
export interface TestDef {
  meta: { id: string; name?: string; tags?: string[]; skip?: boolean; only?: boolean };
  type: "simple" | "steps";
  fn?: TestFn;
  setup?: TestFn;
  steps?: StepDef[];
  teardown?: TestFn;
}

/**
 * The narrow ctx surface Stage 1 exercises — scope-bound, never module globals.
 * Structurally a subset of the SDK TestContext (http/expect/assert/warn/vars/
 * secrets/session/log), enough to run real simple / builder / each tests. The
 * Stage-2 surface (validate/skip/fail/setTimeout/metric/attach) is not here yet.
 */
export interface EngineContext {
  /** ky instance for this run (the same shared ky both hosts use), accepting the
   *  public `prefixUrl` option. */
  http: GlubeanHttp;
  expect(actual: unknown): unknown;
  assert(condition: unknown, message?: string, details?: unknown): void;
  warn(condition: unknown, message?: string): void;
  vars: {
    get(k: string): string | undefined;
    require(k: string, validate?: (value: string) => boolean | string | void | null): string;
    /** A copy of all vars for diagnostics/logging (node parity: harness ctx.vars.all). */
    all(): Record<string, string>;
  };
  secrets: {
    get(k: string): string | undefined;
    require(k: string, validate?: (value: string) => boolean | string | void | null): string;
  };
  session: {
    get(k: string): unknown;
    require(k: string): unknown;
    set(k: string, v: unknown): void;
    entries(): Record<string, unknown>;
  };
  log(message: string, data?: unknown): void;
  /** Validate `data` against a SchemaLike (zod or any safeParse/parse object); emits
   *  a schema_validation event and routes a failure by severity (error→failed
   *  assertion, warn→warning, fatal→failed assertion + abort). Returns the parsed
   *  value on success, else undefined (node parity: harness ctx.validate). */
  validate<T>(data: unknown, schema: SchemaLike<T>, label?: string, options?: ValidateOptions): T | undefined;
  /** Report a numeric metric (node parity: harness ctx.metric). */
  metric(name: string, value: number, options?: MetricOptions): void;
  /** Record a typed interaction (node parity: harness ctx.action). */
  action(a: GlubeanAction): void;
  /** Emit a protocol trace (node parity: harness ctx.trace) — emits a trace event
   *  AND a derived `action` ({protocol}:request). The HTTP auto-trace routes through
   *  this too. */
  trace(request: Trace): void;
  /** Emit a generic structured event (node parity: harness ctx.event — the workflow
   *  first-class unwrap stays node-legacy; the engine always emits generic). */
  event(ev: GlubeanEvent): void;
  /** Set a custom test timeout (ms) — emits a timeout_update control event the parent
   *  uses to re-arm its deadline (node parity: harness ctx.setTimeout). */
  setTimeout(ms: number): void;
  /** Poll `fn` until it returns truthy or `timeoutMs` elapses; on timeout call
   *  `onTimeout` (silent) or throw (node parity: harness ctx.pollUntil). */
  pollUntil(options: PollUntilOptions, fn: () => Promise<boolean | unknown>): Promise<void>;
  /** Two-way branch — only the taken arm runs (node parity: harness ctx.when). The
   *  cloud dry-run projector overrides this to run both arms. */
  when(condition: boolean, thenFn: () => void | Promise<void>, elseFn?: () => void | Promise<void>): Promise<void>;
  /** Multi-way branch — first truthy lazy guard wins and short-circuits, else `defaultFn`
   *  (node parity: harness ctx.switch). */
  switch(cases: SwitchCase[], defaultFn?: () => void | Promise<void>): Promise<void>;
  /** Declarative loop — `while (condition()) await body();` (node parity: harness
   *  ctx.while). The cloud dry-run projector runs the body once. */
  while(condition: () => boolean, body: () => void | Promise<void>): Promise<void>;
  /** Skip the current test with an optional reason (node parity: throws a SkipError
   *  the run-loop turns into a `skipped` verdict; a step/branch-predicate skip skips
   *  the whole test unless a failure was already recorded). */
  skip(reason?: string): never;
  /** Immediately fail + abort: emit a failed assertion (counted even if caught) then
   *  throw, so a steps/branch leg records the failure (node parity: harness ctx.fail). */
  fail(message: string): never;
  /** Test-level retry attempt for this run (0 on the first run). */
  retryCount: number;
  /** Process memory snapshot (node parity: harness ctx.getMemoryUsage → process
   *  .memoryUsage()); null where unavailable (browser) — browser-safe via globalThis. */
  getMemoryUsage(): { heapUsed: number; heapTotal: number; external: number; rss: number } | null;
}

/**
 * Per-run state. THE headline invariant: every piece of per-run state lives here
 * (or in scope.runtime), never in a module-level variable. Two concurrent runs
 * hold two scopes; isolation is whatever the injected Carrier provides.
 */
export interface ExecutionScope {
  runtime: InternalRuntime; // own object identity (configure().http WeakMap-caches per runtime)
  testMeta: { id: string; tags: string[] };
  stepIndex: number;
  /** 0-based index of the step currently running (null outside a step) — events
   *  emitted during a step carry it as `stepIndex`, like the node harness. */
  currentStepIndex: number | null;
  retryCount: number;
  assertions: { total: number; passed: number };
  http: GlubeanHttp;
  session: Record<string, unknown>;
  /** Raw merged vars snapshot for ctx.vars.all() — host raw vars + per-run input.vars,
   *  WITHOUT the fallback-proxy resolution (node parity: {...rawVars}; codex Phase-8 P2). */
  varsAll: Record<string, string>;
  /** The run's ctx, back-filled once makeCtx runs. The scope-bound ky hooks (built
   *  in createScope, BEFORE makeCtx) read it lazily at request time so the HTTP
   *  auto-trace can route through ctx.trace / ctx.metric (→ derived action,
   *  http_duration_ms) + the schema hooks through ctx.assert / ctx.warn. */
  ctxRef?: EngineContext;
  /** Host-provided extra ctx fields (from ScopeInput.ctxExtensions); merged
   *  add-only onto ctx right after makeCtx. */
  ctxExtensions?: Record<string, unknown>;
  /** Run-level abort signal (from ScopeInput.signal): handed to ky and checked between
   *  steps + during the engine's own waits, so an aborted run cancels in-flight HTTP and
   *  stops its poll/retry tail promptly. */
  signal?: AbortSignal;
  /** Per-iteration abort bridge controller, SHARED across the base ky and every
   *  `ctx.http.extend(...)` client of this scope. Lazily created on the first request;
   *  its presence is the "bridge already wired" guard, so exactly one listener is added
   *  to the long-lived `signal` per iteration regardless of how many ky instances exist. */
  httpAbort?: AbortController;
  /** Teardown for per-iteration HTTP resources (the abort bridge that links `signal`
   *  to this iteration's ky). Called once when the iteration's run() settles, so the
   *  single listener on the long-lived `signal` is removed (no accumulation). */
  disposeHttp?: () => void;
}
