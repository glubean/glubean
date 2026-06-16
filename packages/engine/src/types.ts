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

/** ky request options plus Glubean's retained public `prefixUrl` (the engine maps
 *  it to ky 2's `prefix` at the boundary). */
export type GlubeanHttpOptions = Options & { prefixUrl?: string };

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
}

// Every event carries the owning test `id` so a host running runs concurrently
// can attribute assertion/trace/log events to the right run (codex P2-2).
export type ExecutionEvent =
  | { type: "start"; id: string; name: string; tags: string[] }
  | { type: "assertion"; id: string; passed: boolean; message?: string; actual?: unknown; expected?: unknown }
  | { type: "trace"; id: string; method: string; url: string; status: number; timeMs: number }
  | { type: "log"; id: string; message: string; data?: unknown }
  | { type: "status"; id: string; status: "ok" | "error"; error?: string };

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
}

export interface TestResult {
  id: string;
  name: string;
  status: "ok" | "error";
  error?: string;
  assertions: { total: number; passed: number };
}

export type TestFn = (ctx: EngineContext, state?: unknown) => unknown | Promise<unknown>;
export interface StepDef {
  meta: { name: string };
  fn: TestFn;
}
export interface TestDef {
  meta: { id: string; name?: string; tags?: string[] };
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
  vars: { get(k: string): string | undefined; require(k: string): string };
  secrets: { get(k: string): string | undefined; require(k: string): string };
  session: { get(k: string): unknown; set(k: string, v: unknown): void };
  log(message: string, data?: unknown): void;
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
  assertions: { total: number; passed: number };
  http: GlubeanHttp;
  session: Record<string, unknown>;
}
