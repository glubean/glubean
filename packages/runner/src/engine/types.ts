/**
 * @glubean/engine (Stage 1 spike) — environment-agnostic run-loop core.
 *
 * Lives in packages/runner/src/engine during the 1-week isolation gate; promotes
 * to packages/engine once the gate is green (see lite docs/tech-decisions/
 * 0003-step1-execution.md). NodeHost stays node orchestration, browser stays the
 * browser host.
 *
 * Stage 1 goal (the headline go/no-go): prove the run-loop can be expressed using
 * ONLY injected services + an explicit per-run ExecutionScope, with NO module-
 * global coupling, so per-run isolation is delegated entirely to the injected
 * Carrier port. Narrow run-loop only (simple / linear steps); branch / poll /
 * retry / timeout / workflow are Stage 2.
 */
import type { InternalRuntime, RuntimeCarrier } from "@glubean/sdk/internal";

export interface HttpRequestData {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface HttpResponseData {
  status: number;
  statusText?: string;
  headers?: [string, string][];
  body?: string;
  timeMs?: number;
}

/** Host port: the only HTTP egress. node = ky (internal) / browser = extension bridge RPC. */
export interface Transport {
  request(req: HttpRequestData): Promise<HttpResponseData>;
}

/** Host port: vars are available everywhere; secrets are node-only (never browser). */
export interface EnvProvider {
  vars(): Record<string, string>;
  secrets(): Record<string, string>;
}

export type ExecutionEvent =
  | { type: "start"; id: string; name: string; tags: string[] }
  | { type: "assertion"; passed: boolean; message?: string; actual?: unknown; expected?: unknown }
  | { type: "trace"; method: string; url: string; status: number; timeMs: number }
  | { type: "log"; message: string; data?: unknown }
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
  transport: Transport;
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

/** The minimal ctx surface Stage 1 exercises — scope-bound, never module globals. */
export interface EngineContext {
  http: HttpClientLike;
  expect(actual: unknown): unknown;
  vars: { get(k: string): string | undefined; require(k: string): string };
  session: { get(k: string): unknown; set(k: string, v: unknown): void };
  log(message: string, data?: unknown): void;
}

/** ky-shaped enough for configure().http (extend + methods + ResponsePromise). */
export interface HttpCallOpts {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
}
export interface ExtendOpts {
  prefixUrl?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}
export interface ResponseLike {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(k: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export interface ResponsePromise extends Promise<ResponseLike> {
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export interface HttpClientLike {
  (url: string, opts?: HttpCallOpts): ResponsePromise;
  get(url: string, opts?: HttpCallOpts): ResponsePromise;
  post(url: string, opts?: HttpCallOpts): ResponsePromise;
  put(url: string, opts?: HttpCallOpts): ResponsePromise;
  patch(url: string, opts?: HttpCallOpts): ResponsePromise;
  delete(url: string, opts?: HttpCallOpts): ResponsePromise;
  head(url: string, opts?: HttpCallOpts): ResponsePromise;
  extend(opts: ExtendOpts): HttpClientLike;
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
  http: HttpClientLike;
  session: Record<string, unknown>;
}
