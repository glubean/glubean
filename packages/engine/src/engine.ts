/**
 * RunnerCore — the environment-agnostic run-loop (Stage 1 spike).
 *
 * Everything per-run lives in an explicit ExecutionScope; the engine touches NO
 * module-level mutable state. Per-run isolation is delegated entirely to the
 * injected Carrier port: run() wraps the run-loop in runWithRuntime(scope.runtime),
 * so SDK getRuntime() consumers (configure() / session / configured-http) resolve
 * to the active scope. node installs an ALS carrier (true cross-await isolation);
 * the negative-control test installs the globalThis single-slot carrier and the
 * SAME interleaving test must then leak — proving the gate is sensitive.
 *
 * HTTP (Decision B): each run gets a REAL ky instance built with the host-injected
 * fetch + scope-bound trace hooks (keyed by Request, not ky NormalizedOptions —
 * codex P1-2). ky owns the http facade; we only alias the SDK's public `prefixUrl`
 * to ky 2's `prefix` at the boundary (codex P2-5). Narrow run-loop only: simple +
 * linear steps. No branch / poll / retry / timeout / workflow (Stage 2).
 */
import ky, { type KyInstance } from "ky";
import { captureRequestBody, inferJsonSchema, truncateBody, truncateDeep } from "./http-trace.js";
import { Expectation } from "@glubean/sdk";
import type { GlubeanAction, GlubeanEvent, HttpSchemaOptions, MetricOptions, PollUntilOptions, SchemaEntry, SchemaIssue, SchemaLike, SwitchCase, Trace, ValidateOptions } from "@glubean/sdk";
import { installCarrier, runWithRuntime } from "@glubean/sdk/internal";
import type { InternalRuntime } from "@glubean/sdk/internal";
import type {
  EngineContext,
  ExecutionScope,
  GlubeanHttp,
  RunnerServices,
  ScopeInput,
  StepDef,
  TestDef,
  TestFn,
  TestResult,
} from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);

/** URL pathname, or the raw url if it doesn't parse (node parity: trace target). */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** URL pathname, or undefined if it doesn't parse (node parity: the http_duration_ms
 *  metric drops the `path` tag when the url is unparseable, harness.ts:1116-1127). */
function tryPathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * A sleep that resolves after `ms` OR the instant `signal` aborts — whichever comes
 * first. The engine's internal waits (poll interval, retry backoff, ctx.pollUntil)
 * use it so an aborted run (ScopeInput.signal) stops PROMPTLY instead of sitting out a
 * long backoff before it notices the abort. In-flight HTTP is cancelled separately
 * (the signal is handed to ky); this covers the gaps BETWEEN requests. The timer and
 * the abort listener are always torn down, so neither leaks across a long run.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Layer per-run overrides over a host env object WITHOUT a destructive spread, so
 * a fallback-Proxy provider (node: .env → process.env) keeps its fallback for keys
 * the run never overrides. An empty-string override is treated as "unset" (node
 * parity: empty = missing → defer to the provider). (codex P2 / plan 0005 §E)
 */
/**
 * Mirror the node harness's validator semantics for ctx.vars/secrets.require's
 * optional validator callback (codex P2): true / undefined / null = valid; a string
 * = custom error message; anything else (false) = generic validation failure.
 */
function runEngineValidator(result: boolean | string | void | null, key: string, kind: "var" | "secret"): void {
  if (result === true || result === undefined || result === null) return;
  if (typeof result === "string") throw new Error(`Invalid ${kind} "${key}": ${result}`);
  throw new Error(`Invalid ${kind} "${key}": validation failed`);
}

/** A branch step's decision data (test().condition/.switchOn/.switchCond), detected
 *  structurally so the engine needn't import the SDK type-guard. */
interface BranchData {
  mode: "predicate" | "value";
  subject?: (ctx: unknown, state: unknown) => unknown;
  cases: Array<{ value?: unknown; predicate?: (ctx: unknown, state: unknown) => unknown; steps: StepDef[] }>;
  default?: StepDef[];
  message?: string;
}
function branchOf(step: StepDef): BranchData | null {
  const b = (step as { branch?: BranchData }).branch;
  return b && typeof b === "object" && Array.isArray(b.cases) ? b : null;
}

/** A poll step's data (test().poll), detected structurally — same shape as the SDK's
 *  TestPollData. A poll step is a leaf (counts as 1 in countLeafSteps). */
interface PollData {
  fn: TestFn;
  until: (ctx: unknown, res: unknown, state: unknown) => boolean | Promise<boolean>;
  out?: (state: unknown, res: unknown) => unknown;
  every?: number;
  backoff?: number;
  timeout?: number;
  perAttemptTimeout?: number;
  maxAttempts?: number;
}
function pollOf(step: StepDef): PollData | null {
  const p = (step as { poll?: PollData }).poll;
  return p && typeof p === "object" && typeof p.fn === "function" && typeof p.until === "function" ? p : null;
}

/** Count LEAF steps (node parity: leafTotal) — branch cases + default recurse;
 *  used for the `total` on step_start. A linear list counts as its length. */
function countLeafSteps(steps: StepDef[]): number {
  let n = 0;
  for (const s of steps) {
    const br = branchOf(s);
    if (br) {
      for (const c of br.cases) n += countLeafSteps(c.steps);
      n += countLeafSteps(br.default ?? []);
    } else {
      n += 1;
    }
  }
  return n;
}

/** Per-step timeout error — same message/name as the node harness (harness.ts:446)
 *  so step_end.error + classifyErrorReason match. */
class StepTimeoutError extends Error {
  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * ctx.skip() sentinel (node parity: harness.ts SkipError). Caught in the run-loop
 * and turned into a `skipped` verdict — never leaves the engine (the host re-raises
 * its OWN SkipError from the result so the dispatcher's skip status matches). The
 * name matches the node harness so any classifier agrees.
 */
class SkipError extends Error {
  constructor(public readonly reason?: string) {
    super(reason ? `Test skipped: ${reason}` : "Test skipped");
    this.name = "SkipError";
  }
}

/**
 * ctx.fail() sentinel (node parity: harness.ts FailError). ctx.fail emits a failed
 * assertion THEN throws this; in a simple test it propagates as a throw (→ host
 * re-raises → failed), in a step/branch leg it is caught as the step error message.
 */
class FailError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "FailError";
  }
}

/**
 * Core schema validation (node parity: harness.ts:runSchemaValidation). Duck-types
 * `safeParse` (preferred) / `parse` so it stays browser-safe — no zod import. Always
 * emits a schema_validation event (via the injected emitter), then routes a FAILURE
 * by severity through the injected assert/warn (so it shares the run-loop's assertion
 * counters + stepIndex). `fatal` emits a failed assertion then throws to abort. Shared
 * by ctx.validate and (Phase 4f) the HTTP schema hooks.
 */
function runSchemaValidation<T>(
  data: unknown,
  schema: SchemaLike<T>,
  label: string,
  severity: "error" | "warn" | "fatal",
  deps: {
    emitSchemaValidation: (p: {
      label: string;
      success: boolean;
      severity: "error" | "warn" | "fatal";
      issues?: SchemaIssue[];
    }) => void;
    assert: (passed: boolean, message: string) => void;
    warn: (condition: boolean, message: string) => void;
  },
): { success: true; data: T } | { success: false; issues: SchemaIssue[] } {
  let success = false;
  let parsed: T | undefined;
  let issues: SchemaIssue[] = [];

  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(data);
    if (result.success) {
      success = true;
      parsed = result.data;
    } else {
      issues = (result.error?.issues ?? []).map((i) => ({ message: i.message, ...(i.path ? { path: i.path } : {}) }));
    }
  } else if (typeof schema.parse === "function") {
    try {
      parsed = schema.parse(data);
      success = true;
    } catch (err: unknown) {
      const errObj = err as { issues?: ReadonlyArray<{ message?: string; path?: ReadonlyArray<PropertyKey> }> };
      if (errObj?.issues && Array.isArray(errObj.issues)) {
        issues = errObj.issues.map((i) => ({ message: i.message ?? String(i), ...(i.path ? { path: i.path } : {}) }));
      } else {
        issues = [{ message: err instanceof Error ? err.message : String(err) }];
      }
    }
  } else {
    issues = [{ message: "Schema has neither safeParse nor parse method" }];
  }

  deps.emitSchemaValidation({ label, success, severity, ...(issues.length > 0 ? { issues } : {}) });

  if (!success) {
    const issuesSummary = issues
      .map((i) => (i.path ? i.path.join(".") + ": " : "") + i.message)
      .join("; ");
    const msg = `Schema validation failed: ${label} — ${issuesSummary}`;
    switch (severity) {
      case "error":
        deps.assert(false, msg);
        break;
      case "warn":
        deps.warn(false, msg);
        break;
      case "fatal":
        deps.assert(false, msg);
        throw new FailError(msg);
    }
    return { success: false, issues };
  }

  return { success: true, data: parsed as T };
}

/**
 * Serialize a step's return state for the step_end event with the node harness's
 * 4 KB guard: keep the value if it serializes ≤ 4096 bytes, else a truncated marker;
 * a non-serializable value becomes a marker (codex parity).
 */
function serializeReturnState(value: unknown): unknown {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== "string") return "[non-serializable]";
    return s.length <= 4096 ? value : `[truncated: ${s.length} bytes]`;
  } catch {
    return "[non-serializable]";
  }
}

function layerEnv(
  provider: Record<string, string>,
  overlay?: Record<string, string>,
): Record<string, string> {
  if (!overlay || Object.keys(overlay).length === 0) return provider;
  return new Proxy(provider, {
    get(target, prop: string) {
      const o = overlay[prop];
      return o !== undefined && o !== "" ? o : target[prop];
    },
    has(target, prop: string) {
      // Empty overlay value = unset → defer to the provider (so ctx.vars.require,
      // which checks `k in vars`, still throws for a genuinely-missing key). (codex P2)
      const o = overlay[prop];
      if (o !== undefined && o !== "") return true;
      return prop in target;
    },
  });
}

export class RunnerCore {
  constructor(private readonly services: RunnerServices) {
    // Install the host carrier as the SDK's global carrier so getRuntime()
    // (configure/session/configured-http) resolves through it.
    installCarrier(services.carrier);
  }

  /**
   * Run one test in an isolated scope. The whole run-loop — including every async
   * continuation in user code — executes inside runWithRuntime(scope.runtime).
   */
  run(def: TestDef, input: ScopeInput = {}): Promise<TestResult> {
    // Honor an explicitly skipped test: never execute it (no side effects) —
    // node-harness parity (codex B4 P2).
    if (def.meta.skip) {
      // No status EVENT — status emission is host policy (the runner emits the
      // skipped status at dispatch; the browser derives it from this result).
      return Promise.resolve({
        id: def.meta.id,
        name: def.meta.name ?? def.meta.id,
        status: "skipped",
        assertions: { total: 0, passed: 0 },
      });
    }
    const scope = this.createScope(def, input);
    // Tear down per-iteration HTTP resources (the abort bridge) once the run settles,
    // so the single listener on the long-lived run signal is removed (no accumulation).
    return runWithRuntime(scope.runtime, () => this.runLoop(def, scope)).finally(() =>
      scope.disposeHttp?.(),
    );
  }

  /**
   * Runtime-authoritative resolution of a module namespace into runnable TestDefs
   * (SoT §3.2: the static scanner is UI-only; this is the权威 resolver). Handles
   * plain Test, Test[], TestBuilder, and EachBuilder — each `test.each` row
   * becomes its own def. Narrow Stage-1 surface (no workflow/contract expansion).
   */
  resolve(namespace: Record<string, unknown>): TestDef[] {
    const defs: TestDef[] = [];
    for (const value of Object.values(namespace ?? {})) collectDefs(value, defs);
    return defs;
  }

  private createScope(def: TestDef, input: ScopeInput): ExecutionScope {
    const { env, events } = this.services;
    // Layer per-run input OVER the host EnvProvider WITHOUT a destructive spread,
    // so a host whose vars()/secrets() is a fallback Proxy (node: .env → process.env)
    // keeps that fallback for keys the run never overrides (codex P2 / plan 0005 §E).
    const vars = layerEnv(env.vars(), input.vars);
    const secrets = layerEnv(env.secrets(), input.secrets);
    const session: Record<string, unknown> = { ...(input.session ?? {}) };
    // Raw snapshot for ctx.vars.all() (node parity: {...rawVars}). Use the host's RAW
    // map (varsAll) so empty/overlay vars aren't lost to the fallback Proxy; layer the
    // per-run input on top. Falls back to spreading vars() for hosts without varsAll
    // (e.g. a browser host whose vars() is already a plain map). (codex Phase-8 P2)
    const varsAll: Record<string, string> = { ...(env.varsAll ? env.varsAll() : env.vars()), ...(input.vars ?? {}) };

    const scope: ExecutionScope = {
      runtime: undefined as unknown as InternalRuntime,
      testMeta: { id: def.meta.id, tags: def.meta.tags ?? [] },
      stepIndex: 0,
      currentStepIndex: null,
      retryCount: input.retryCount ?? 0,
      assertions: { total: 0, passed: 0 },
      // assigned just below once the scope exists (the ky trace hook reads the live
      // scope.currentStepIndex so HTTP traces inside a step carry stepIndex).
      http: undefined as unknown as GlubeanHttp,
      session,
      varsAll,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.ctxExtensions ? { ctxExtensions: input.ctxExtensions } : {}),
    };
    const http = this.createScopedKy(scope);
    scope.http = http;

    // Fresh runtime object per run (configure().http WeakMap-caches per identity).
    scope.runtime = {
      vars,
      secrets,
      session, // same ref as scope.session, so ctx.session.set is visible to session.get
      http: http as unknown as InternalRuntime["http"],
      get test() {
        return scope.testMeta as unknown as InternalRuntime["test"];
      },
      log: (message: string, data?: unknown) => events.emit({ type: "log", id: def.meta.id, message, data }),
      // configure() plugins resolve trace/action/event from the CARRIER runtime, not
      // the ctx object (configure/plugin.ts: `runtime.trace ?? noop`). The legacy
      // harness wires these via setRuntime (`trace: ctx.trace`, …); forward them here
      // too so an engine-routed plugin test keeps its trace/action/event evidence —
      // else plugins (e.g. @glubean/grpc) silently no-op (codex 4c-e P2). Delegated to
      // scope.ctxRef (back-filled before any user code resolves a plugin) so they
      // carry the run's stepIndex, exactly like ctx.trace/action/event.
      trace: (t) => scope.ctxRef?.trace(t),
      action: (a) => scope.ctxRef?.action(a),
      event: (ev) => scope.ctxRef?.event(ev),
    };
    return scope;
  }

  /**
   * Build a per-run ky instance: host fetch + scope-bound trace hooks. Per-request
   * state is keyed by ky 2's stable `options.context` object (NOT the Request, which
   * a hook may replace when an auth helper rebuilds it — codex ky2 P2 / plan 0005 §D).
   * throwHttpErrors:false matches the node harness default so 4xx/5xx surface as
   * responses, not throws. The auto-trace routes through scope.ctxRef.trace (→ trace
   * event + derived action) + ctx.metric("http_duration_ms"), so it shares the run's
   * stepIndex attribution (node parity: harness.ts:1010-1133).
   */
  private createScopedKy(scope: ExecutionScope): GlubeanHttp {
    const { fetch: hostFetch, scheduler } = this.services;
    const emitFullTrace = this.services.http?.emitFullTrace ?? false;
    const inferSchema = this.services.http?.inferSchema ?? false;
    const truncateArrays = this.services.http?.truncateArrays ?? false;
    // Per-request state keyed by ky 2's stable options.context (not the Request).
    const reqState = new WeakMap<object, { startTime: number; body?: unknown }>();
    const instance = ky.create({
      fetch: hostFetch as typeof fetch,
      throwHttpErrors: false,
      // Match the node harness default: no implicit retries (authors opt in
      // per-request). ky 2 retries GET/HEAD by default, which would mask
      // transient failures and emit extra requests/traces. (codex engine P2)
      retry: 0,
      hooks: {
        beforeRequest: [
          async ({ request, options }) => {
            reqState.set(options.context, {
              startTime: scheduler.now(),
              // Capture the request body (ky 2 hides options.json) for full-trace.
              body: emitFullTrace ? await captureRequestBody(request) : undefined,
            });
          },
        ],
        afterResponse: [
          async ({ request, options, response }) => {
            const ctx = scope.ctxRef;
            // No ctx yet (a request before makeCtx) should never happen during a run;
            // bail rather than emit an un-attributed trace.
            if (!ctx) return response;
            const state = reqState.get(options.context);
            const durationMs = Math.round(scheduler.now() - (state?.startTime ?? scheduler.now()));
            // `request` is the final (possibly hook-replaced) request — correct target.
            const pathname = pathnameOf(request.url);
            const trace: Trace = {
              protocol: "http",
              target: `${request.method} ${pathname}`,
              status: response.status,
              durationMs,
              ok: response.status < 400,
              // Deprecated HTTP back-compat fields (node parity: harness.ts:1043).
              method: request.method,
              url: request.url,
              duration: durationMs,
            };
            // Operation name from the GraphQL client (X-Glubean-Op header).
            const glubeanOp = request.headers.get("x-glubean-op");
            if (glubeanOp) trace.name = glubeanOp;
            // Exact route template from a contract.http() client / a `context` option,
            // e.g. "GET /runs/:runId". Carried via ky's NON-WIRE `context` (never a request
            // header), so it can't leak to the SUT through any client — the load runner uses
            // it for an exact endpoint routeKey instead of heuristic URL normalization.
            const ctxRoute = (options.context as { glubeanRoute?: string } | undefined)?.glubeanRoute;
            if (ctxRoute) trace.routeKey = ctxRoute;

            // Full-trace capture (node parity: harness.ts:1062-1106), gated by
            // emitFullTrace. Reads a CLONE so the user's res.json()/text() still works.
            if (emitFullTrace) {
              trace.requestHeaders = Object.fromEntries(request.headers.entries());
              if (state?.body !== undefined) trace.requestBody = truncateBody(state.body);
              trace.responseHeaders = Object.fromEntries(response.headers.entries());
              try {
                const cloned = response.clone();
                const contentType = response.headers.get("content-type") || "";
                let parsedBody: unknown;
                if (contentType.includes("json")) parsedBody = await cloned.json();
                else if (contentType.includes("text") || contentType.includes("xml")) parsedBody = await cloned.text();
                if (parsedBody !== undefined) {
                  // Schema inference runs on the FULL body before any truncation.
                  if (inferSchema && typeof parsedBody === "object" && parsedBody !== null) {
                    trace.responseSchema = inferJsonSchema(parsedBody);
                  }
                  trace.responseBody = truncateArrays ? truncateDeep(parsedBody) : truncateBody(parsedBody);
                }
                // Binary content types are intentionally skipped.
              } catch {
                // Ignore clone/parse errors — trace still emits without the body.
              }
            }

            // ctx.trace emits the trace event + the derived `http:request` action.
            ctx.trace(trace);
            // Auto-metric for response time (node parity: harness.ts:1116).
            const urlPath = tryPathname(request.url);
            ctx.metric("http_duration_ms", durationMs, {
              unit: "ms",
              tags: urlPath !== undefined ? { method: request.method, path: urlPath } : { method: request.method },
            });
            return response;
          },
        ],
      },
    });
    return wrapScopedKy(instance, scope, this.services.http?.abortMode ?? "precise");
  }

  private async runLoop(def: TestDef, scope: ExecutionScope): Promise<TestResult> {
    const { events, scheduler } = this.services;
    events.emit({
      type: "start",
      id: scope.testMeta.id,
      name: def.meta.name ?? def.meta.id,
      tags: scope.testMeta.tags,
      ...(scope.retryCount > 0 ? { retryCount: scope.retryCount } : {}),
    });
    const ctx = this.makeCtx(scope);
    // Host-provided ctx extensions (e.g. the load runner's input / report /
    // producerSlot / iteration). ADD-only: never override a built-in ctx member.
    // The engine does not interpret these — it only surfaces them on ctx.
    if (scope.ctxExtensions) {
      const target = ctx as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(scope.ctxExtensions)) {
        if (!(key in target)) target[key] = value;
      }
    }
    // Back-fill so the scope-bound ky hooks (built in createScope, before makeCtx)
    // can route the HTTP auto-trace through ctx.trace / ctx.metric at request time.
    scope.ctxRef = ctx;

    let threw = false;
    let thrownError: string | undefined;
    let thrownStack: string | undefined;
    let thrownName: string | undefined;
    // The run-level abort signal (ScopeInput.signal) fired while the run was in flight.
    // Set authoritatively post-loop from `scope.signal?.aborted` (true there can only mean
    // the abort happened before the run returned). Forces an "error" verdict even when the
    // steps that DID run passed — including a final/only step or a simple body that ran to
    // completion through opaque, non-cancellable async (codex r1 P2). A signal that aborts
    // only after this run has returned is never observed here, so a genuinely-finished run
    // keeps its real verdict.
    let aborted = false;
    // A step that throws is CAUGHT + recorded as a failed step (node parity: the
    // run still "completes"); it must still make the test's verdict error.
    let stepFailed = false;
    let stepFailMsg: string | undefined;
    // The first failing step's error NAME (e.g. "TimeoutError" / "HTTPError" /
    // "StepTimeoutError"), captured so a host can classify a CAUGHT step failure —
    // unlike a top-level throw, the engine swallows it, so `errorName` (top-level
    // only) would be empty. Mirrors stepFailMsg's first-wins semantics.
    let stepErrorName: string | undefined;
    // Control-flow halt, distinct from the `stepFailed` verdict: once set, the
    // remaining steps are skipped. A thrown step (and branch/poll failures) always
    // halt; a step with `continueOnAssertionFailure` whose ONLY failure was soft
    // assertions records the failure (stepFailed) WITHOUT halting (load `continue`
    // policy). Default keeps node parity: any step failure halts.
    let haltSteps = false;
    // First branch-decision failure → the test-level failure message (node parity:
    // the post-loop throw prefers it over "One or more steps failed").
    let branchDecisionError: string | undefined;
    // ctx.skip() reached us: in a steps run a step/branch-predicate skip sets this
    // (no throw — skips remaining steps + skips the whole test after teardown, node
    // parity). A simple-test / setup skip propagates as a throw to the catch below.
    let skipRequest: SkipError | undefined;
    let skipped = false;
    let skipReason: string | undefined;
    try {
      if (def.type === "simple") {
        // Pre-aborted (the signal was already aborted before the run): never run the body
        // — the post-loop abort check makes the verdict an error, no side effects (codex r1
        // P2). A mid-run abort is handled inline (ky cancels in-flight HTTP).
        if (!scope.signal?.aborted) {
          if (!def.fn) throw new Error(`test "${def.meta.id}": missing fn`);
          await def.fn(ctx);
        }
      } else {
        let state: unknown;
        const stepTotal = countLeafSteps(def.steps ?? []);
        let stepSeq = 0; // monotonic LEAF step index (continues across branches)
        let branchSeq = 0; // separate index for branch decision events

        // Recursive skipped-step emission (node parity: emitSkippedTree) — a skipped
        // step_end per leaf (no attempts/retriesUsed); branch cases recurse.
        const emitSkippedTree = (steps: StepDef[]): void => {
          for (const s of steps) {
            const br = branchOf(s);
            if (br) {
              for (const c of br.cases) emitSkippedTree(c.steps as StepDef[]);
              emitSkippedTree((br.default ?? []) as StepDef[]);
            } else {
              events.emit({
                type: "step_end",
                id: scope.testMeta.id,
                index: stepSeq++,
                name: s.meta.name,
                status: "skipped",
                durationMs: 0,
                assertions: 0,
                failedAssertions: 0,
                ...(s.meta.group !== undefined ? { group: s.meta.group } : {}),
              });
            }
          }
        };

        // Run one normal (non-branch) step with retry/timeout (node parity).
        const runNormalStep = async (step: StepDef): Promise<void> => {
          const idx = stepSeq++;
          scope.currentStepIndex = idx;
          const startedAt = scheduler.now();
          events.emit({
            type: "step_start",
            id: scope.testMeta.id,
            index: idx,
            name: step.meta.name,
            total: stepTotal,
            ...(step.meta.group !== undefined ? { group: step.meta.group } : {}),
          });

          const sm = (step as {
            meta?: { retries?: number; retryDelay?: number; backoff?: number; timeout?: number; continueOnAssertionFailure?: boolean };
          }).meta ?? {};
          const configuredRetries = Number.isFinite(sm.retries) ? Math.max(0, Math.floor(sm.retries as number)) : 0;
          const retryDelayMs = Number.isFinite(sm.retryDelay) ? Math.max(0, sm.retryDelay as number) : configuredRetries > 0 ? 1000 : 0;
          const backoff = Number.isFinite(sm.backoff) ? Math.max(1, sm.backoff as number) : 1;
          const stepTimeoutMs = Number.isFinite(sm.timeout) && (sm.timeout as number) > 0 ? Math.floor(sm.timeout as number) : undefined;
          const maxAttempts = configuredRetries + 1;

          let stepError: string | undefined;
          let stepErrorNameLocal: string | undefined;
          let stepReturnState: unknown;
          let attemptsUsed = 0;
          let lastAssertions = 0;
          let lastFailedAssertions = 0;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            attemptsUsed = attempt;
            stepError = undefined;
            stepErrorNameLocal = undefined;
            stepReturnState = undefined;
            const aBefore = scope.assertions.total;
            const fBefore = scope.assertions.total - scope.assertions.passed;
            let timedOut = false;
            try {
              const call = step.fn!(ctx, state);
              if (stepTimeoutMs === undefined) {
                const next = await call;
                if (next !== undefined) { state = next; stepReturnState = next; }
              } else {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const next = await Promise.race([
                    call,
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new StepTimeoutError(step.meta.name, stepTimeoutMs)), stepTimeoutMs);
                    }),
                  ]);
                  if (next !== undefined) { state = next; stepReturnState = next; }
                } finally {
                  if (timer !== undefined) clearTimeout(timer);
                }
              }
            } catch (e) {
              if (e instanceof SkipError) {
                // ctx.skip() inside a step skips the WHOLE test — not a step failure,
                // and never retried (node parity: harness.ts:2219).
                skipRequest = e;
              } else {
                // A thrown step is caught + recorded as a failed step (node parity:
                // the run still "completes"; the test fails via stepsFailed).
                stepError = e instanceof Error ? e.message : String(e);
                stepErrorNameLocal = e instanceof Error ? e.name : undefined;
                timedOut = e instanceof StepTimeoutError;
              }
            }
            lastAssertions = scope.assertions.total - aBefore;
            lastFailedAssertions = scope.assertions.total - scope.assertions.passed - fBefore;
            if (skipRequest) break; // skip is terminal — never retry a skip
            // An abort (run-level signal) is terminal too: this attempt's failure (an
            // in-flight HTTP threw AbortError) stands; never retry into a shutting-down run.
            if (scope.signal?.aborted) break;
            const attemptFailed = !!stepError || lastFailedAssertions > 0;
            if (!attemptFailed || timedOut) break; // success, or a timeout (terminal — no retry)
            if (attempt < maxAttempts) {
              const delay = Math.min(retryDelayMs * backoff ** (attempt - 1), 30_000);
              const reason = stepError ? stepError : `${lastFailedAssertions} failed assertion(s)`;
              events.emit({
                type: "log",
                id: scope.testMeta.id,
                stepIndex: idx,
                message: `Retrying step "${step.meta.name}" (${attempt + 1}/${maxAttempts}) after failure: ${reason}${delay > 0 ? ` (waiting ${delay}ms)` : ""}`,
              });
              if (delay > 0) await abortableSleep(delay, scope.signal);
              // An abort that fired DURING the backoff wakes the sleep early; bail before
              // the next attempt runs, so post-abort user code never executes and this
              // failed attempt's verdict isn't overwritten by a retry (codex r1 P2).
              if (scope.signal?.aborted) break;
            }
          }

          // ctx.skip() in this step skips the whole test — UNLESS a failed assertion
          // was already recorded before the skip, in which case the failure wins (a
          // skip must not mask a real failure; node parity: harness.ts:2275). On a
          // clean skip: emit a skipped step_end (with attempts/retriesUsed) and return;
          // runStepList sees skipRequest set and skips the remaining steps.
          if (skipRequest && lastFailedAssertions === 0) {
            events.emit({
              type: "step_end",
              id: scope.testMeta.id,
              index: idx,
              name: step.meta.name,
              status: "skipped",
              durationMs: scheduler.now() - startedAt,
              assertions: lastAssertions,
              failedAssertions: 0,
              attempts: attemptsUsed,
              retriesUsed: Math.max(0, attemptsUsed - 1),
            });
            scope.currentStepIndex = null;
            return;
          }
          // A prior failure overrides the skip — report this step (+ the test) failed.
          skipRequest = undefined;

          const failed = !!stepError || lastFailedAssertions > 0;
          events.emit({
            type: "step_end",
            id: scope.testMeta.id,
            index: idx,
            name: step.meta.name,
            status: failed ? "failed" : "passed",
            durationMs: scheduler.now() - startedAt,
            assertions: lastAssertions,
            failedAssertions: lastFailedAssertions,
            attempts: attemptsUsed,
            retriesUsed: Math.max(0, attemptsUsed - 1),
            ...(stepError ? { error: stepError } : {}),
            ...(stepReturnState !== undefined ? { returnState: serializeReturnState(stepReturnState) } : {}),
          });
          scope.currentStepIndex = null;
          if (failed) {
            stepFailed = true;
            if (stepError && stepFailMsg === undefined) {
              stepFailMsg = stepError;
              stepErrorName = stepErrorNameLocal;
            }
            // A throw always halts; an assertion-only failure halts unless this
            // step opted into `continue` (load `continue` assertion policy).
            if (stepError || sm.continueOnAssertionFailure !== true) haltSteps = true;
          }
        };

        // Recursive step-list runner (node parity: runStepList). A prior failure
        // skips the rest (skipped step_end tree). branch handling lands in Phase 2.
        // Branch step (test().condition / .switchOn / .switchCond): make the decision
        // ONCE, emit a `branch` event, run the taken case's sub-steps as first-class
        // steps, and skip every non-taken case + (if a case matched) the default —
        // in registry order so stepSeq stays aligned (node parity: runBranchStep).
        const runBranchStep = async (step: StepDef, branch: BranchData): Promise<void> => {
          scope.currentStepIndex = null;
          const failedBefore = scope.assertions.total - scope.assertions.passed;
          let takenIndex: number | "default" = "default";
          let takenValue: string | number | boolean | null | undefined;
          const total = branch.cases.length;
          const baseEvent = { id: scope.testMeta.id, name: step.meta.name, ...(branch.message ? { message: branch.message } : {}) };
          const failDecision = (errMessage: string, errName?: string): void => {
            events.emit({ type: "branch", ...baseEvent, index: branchSeq++, takenIndex: "default", total, error: errMessage });
            stepFailed = true;
            haltSteps = true; // a branch-decision failure is hard — always halt.
            if (branchDecisionError === undefined) branchDecisionError = `branch "${step.meta.name}": ${errMessage}`;
            // Capture a THROWN decision error's name (not an assertion/skip) so a host
            // classifies a predicate/lens code error or timeout, not as an assertion.
            if (errName !== undefined && stepErrorName === undefined) stepErrorName = errName;
            for (const c of branch.cases) emitSkippedTree(c.steps);
            emitSkippedTree(branch.default ?? []);
          };

          try {
            if (branch.mode === "value") {
              // Subject lens evaluated EXACTLY ONCE (lenses may be impure); await so
              // an async lens resolves to its scalar before matching.
              const subject = branch.subject ? await branch.subject(ctx, state) : undefined;
              for (let ci = 0; ci < branch.cases.length; ci++) {
                if (subject === branch.cases[ci].value) {
                  takenIndex = ci;
                  takenValue = branch.cases[ci].value as typeof takenValue;
                  break;
                }
              }
            } else {
              for (let ci = 0; ci < branch.cases.length; ci++) {
                const pred = branch.cases[ci].predicate;
                if (!pred) continue;
                const result = await pred(ctx, state);
                if (typeof result !== "boolean") {
                  throw new Error(
                    `condition / switchCond predicate must return a boolean; got ${result === null ? "null" : typeof result}`,
                  );
                }
                if (result) {
                  takenIndex = ci;
                  break;
                }
              }
            }
          } catch (e) {
            const decisionFailed = scope.assertions.total - scope.assertions.passed - failedBefore;
            if (e instanceof SkipError && decisionFailed === 0) {
              // ctx.skip() in a predicate/lens skips the WHOLE test (node parity:
              // harness.ts:2573) — emit a default-taken branch with NO error + skip
              // every sub-step; runStepList then skips the remaining steps.
              skipRequest = e;
              events.emit({ type: "branch", ...baseEvent, index: branchSeq++, takenIndex: "default", total });
              for (const c of branch.cases) emitSkippedTree(c.steps);
              emitSkippedTree(branch.default ?? []);
              return;
            }
            // Decision failure (§7.4): the test fails; never silently take a branch. A
            // skip preceded by a failed assertion reports that failure (failure wins).
            failDecision(
              e instanceof SkipError
                ? `${decisionFailed} failed assertion(s) before ctx.skip() in branch decision`
                : e instanceof Error
                  ? e.message
                  : String(e),
              // Only a genuine throw carries a classifiable name; a skip-before-failure
              // is an assertion-flavoured decision failure (left unnamed).
              !(e instanceof SkipError) && e instanceof Error ? e.name : undefined,
            );
            return;
          }

          // A ctx.assert(false) failure recorded WHILE deciding fails the branch (the
          // assertion event is outside any step, so step-authority would miss it).
          const decisionFailed = scope.assertions.total - scope.assertions.passed - failedBefore;
          if (decisionFailed > 0) {
            failDecision(`${decisionFailed} failed assertion(s) during branch decision`);
            return;
          }

          events.emit({
            type: "branch",
            ...baseEvent,
            index: branchSeq++,
            takenIndex,
            ...(takenValue !== undefined ? { takenValue } : {}),
            total,
          });
          // Leaves in registry order: cases 0..N then default — run the taken one,
          // skip the rest IN PLACE (keeps stepSeq aligned with discovery order).
          for (let ci = 0; ci < branch.cases.length; ci++) {
            if (ci === takenIndex) await runStepList(branch.cases[ci].steps);
            else emitSkippedTree(branch.cases[ci].steps);
          }
          if (takenIndex === "default") await runStepList(branch.default ?? []);
          else emitSkippedTree(branch.default ?? []);
        };

        // Execute a poll step (test().poll): a first-class leaf step whose body is a
        // bounded retry of `fn` until `until` holds (or a bound exhausts → it fails).
        // Each attempt is RACED against its budget (best-effort: arbitrary user fn/until
        // can't be force-cancelled, but the step never waits past the budget). Emits a
        // `poll` event (attempts/elapsed/satisfied/exhausted) + the normal step_start/
        // step_end. Assertions accumulate across attempts (node parity: harness.ts:2345).
        const runPollStep = async (step: StepDef, poll: PollData): Promise<void> => {
          const idx = stepSeq++;
          scope.currentStepIndex = idx;
          const aBefore = scope.assertions.total;
          const fBefore = scope.assertions.total - scope.assertions.passed;
          const stepStart = scheduler.now();
          events.emit({
            type: "step_start",
            id: scope.testMeta.id,
            index: idx,
            name: step.meta.name,
            total: stepTotal,
            ...(step.meta.group !== undefined ? { group: step.meta.group } : {}),
          });

          // Local budget sentinel so a budget timeout is distinguishable from a genuine
          // fn/until error or a SkipError.
          class PollBudgetTimeout extends Error {}
          const raceBudget = <T>(p: Promise<T>, budgetMs: number): Promise<T> => {
            if (!Number.isFinite(budgetMs)) return p;
            return new Promise<T>((resolve, reject) => {
              const t = setTimeout(() => reject(new PollBudgetTimeout()), Math.max(0, budgetMs));
              p.then(
                (v) => { clearTimeout(t); resolve(v); },
                (e) => { clearTimeout(t); reject(e); },
              );
            });
          };

          const everyMs = poll.every ?? 1000;
          const backoff = poll.backoff ?? 1;
          const perAttempt = poll.perAttemptTimeout ?? Infinity;
          const start = scheduler.now();
          const deadline = poll.timeout !== undefined ? start + poll.timeout : Infinity;
          let attempt = 0;
          let delay = everyMs;
          let satisfied = false;
          let exhausted = false;
          let pollError: string | undefined;
          let pollErrorName: string | undefined;
          let lastRes: unknown;
          // A poll-phase throw must surface a non-empty message: pollError is tested for
          // truthiness below to decide failure, so an empty message would be a silent pass.
          // Also captures the thrown error's NAME (only ever called on a real throw) so a
          // host can classify a caught poll failure (e.g. ky "TimeoutError").
          const pollErrMsg = (e: unknown): string => {
            pollErrorName = e instanceof Error ? e.name : undefined;
            const m = e instanceof Error ? e.message : String(e);
            return m || `poll "${step.meta.name}" threw an empty error`;
          };

          for (;;) {
            // Aborted (run-level signal) — stop the poll tail at once. Distinct from
            // exhaustion: the run is shutting down, not the poll's own budget running out.
            // (An abort DURING an attempt's HTTP surfaces as a caught AbortError below; this
            // catches an abort during the inter-attempt wait, which abortableSleep wakes.)
            if (scope.signal?.aborted) {
              pollError = `poll "${step.meta.name}" aborted`;
              pollErrorName = "AbortError";
              break;
            }
            attempt += 1;
            const remainingTotal = deadline - scheduler.now();
            if (remainingTotal <= 0) { exhausted = true; break; }
            const attemptBudget = Math.min(perAttempt, remainingTotal);
            const attemptStart = scheduler.now();

            // Attempt fn (best-effort raced).
            try {
              lastRes = await raceBudget(Promise.resolve(poll.fn(ctx, state)), attemptBudget);
            } catch (err) {
              if (err instanceof SkipError) { skipRequest = err; break; }
              if (err instanceof PollBudgetTimeout) { exhausted = true; break; }
              pollError = pollErrMsg(err);
              break;
            }
            if (scheduler.now() > deadline || scheduler.now() - attemptStart > perAttempt) { exhausted = true; break; }

            // Exit predicate (raced to the remaining attempt budget).
            let done: boolean;
            try {
              const predBudget = Math.min(deadline - scheduler.now(), perAttempt - (scheduler.now() - attemptStart));
              const out = await raceBudget(Promise.resolve(poll.until(ctx, lastRes, state)), Math.max(0, predBudget));
              if (typeof out !== "boolean") {
                pollError = `poll "${step.meta.name}": until must return a boolean; got ${out === null ? "null" : typeof out}`;
                break;
              }
              done = out;
            } catch (err) {
              if (err instanceof SkipError) { skipRequest = err; break; }
              if (err instanceof PollBudgetTimeout) { exhausted = true; break; }
              pollError = pollErrMsg(err);
              break;
            }

            if (done) {
              satisfied = true;
              if (poll.out) {
                // A throwing out-mapper fails the poll through the normal path (poll
                // event + step_end below), not by escaping.
                try {
                  const next = poll.out(state, lastRes);
                  if (next !== undefined) state = next;
                } catch (err) {
                  pollError = pollErrMsg(err);
                }
              }
              break;
            }

            // Not satisfied → check bounds, then wait.
            if (poll.maxAttempts && attempt >= poll.maxAttempts) { exhausted = true; break; }
            if (Number.isFinite(deadline) && scheduler.now() + delay >= deadline) { exhausted = true; break; }
            await abortableSleep(delay, scope.signal);
            delay = Math.min(delay * backoff, 30_000);
          }

          const durationMs = scheduler.now() - stepStart;
          const failedAssertions = scope.assertions.total - scope.assertions.passed - fBefore;
          const assertions = scope.assertions.total - aBefore;

          // ctx.skip() in fn/until skips the whole test (unless a failure/exhaustion was
          // already recorded — failure wins, node parity: harness.ts:2464).
          if (skipRequest && failedAssertions === 0 && !pollError && !exhausted) {
            events.emit({
              type: "step_end",
              id: scope.testMeta.id,
              index: idx,
              name: step.meta.name,
              status: "skipped",
              durationMs,
              assertions,
              failedAssertions: 0,
              attempts: attempt,
            });
            scope.currentStepIndex = null;
            return;
          }
          skipRequest = undefined;

          if (exhausted && !pollError) {
            pollError = `poll "${step.meta.name}" exhausted: condition not met after ${attempt} attempt(s)`;
          }
          const failed = !!pollError || failedAssertions > 0 || !satisfied;

          events.emit({
            type: "poll",
            id: scope.testMeta.id,
            index: idx,
            name: step.meta.name,
            attempts: attempt,
            elapsedMs: Math.round(scheduler.now() - start),
            satisfied,
            exhausted,
            ...(pollError ? { error: pollError } : {}),
          });
          events.emit({
            type: "step_end",
            id: scope.testMeta.id,
            index: idx,
            name: step.meta.name,
            status: failed ? "failed" : "passed",
            durationMs,
            assertions,
            failedAssertions,
            attempts: attempt,
            ...(pollError ? { error: pollError } : {}),
          });
          scope.currentStepIndex = null;
          if (failed) {
            stepFailed = true;
            // A HARD poll failure (threw / exhausted / `until` never met) always
            // halts; a poll that satisfied but recorded only soft assertions
            // respects `continueOnAssertionFailure`, exactly like a normal step.
            const hardFailure = !!pollError || !satisfied;
            if (hardFailure || step.meta.continueOnAssertionFailure !== true) haltSteps = true;
            if (pollError && stepFailMsg === undefined) {
              stepFailMsg = pollError;
              stepErrorName = pollErrorName;
            }
          }
        };

        // Recursive step-list runner (node parity: runStepList). A prior failure
        // skips the rest (skipped step_end tree); branch steps make a decision + recurse.
        const runStepList = async (steps: StepDef[]): Promise<void> => {
          for (const step of steps) {
            // An aborted run starts no further steps (the in-flight one, if any, is
            // cancelled via ky's signal); the remaining steps emit a skipped tree. The
            // post-loop abort check turns this into an error verdict — the run can't pass.
            if (haltSteps || skipRequest || scope.signal?.aborted) {
              emitSkippedTree([step]);
              continue;
            }
            const branch = branchOf(step);
            if (branch) {
              await runBranchStep(step, branch);
              continue;
            }
            const poll = pollOf(step);
            if (poll) {
              await runPollStep(step, poll);
              continue;
            }
            await runNormalStep(step);
          }
        };

        if (scope.signal?.aborted) {
          // Pre-aborted (the signal was already aborted before the run): run NOTHING —
          // no setup, no steps, and no teardown (there was no setup to undo). Emit the
          // skipped tree so the event stream still shows every step skipped; the post-loop
          // abort check makes the verdict an error (codex r1 P2). A mid-run abort is handled
          // inline (ky cancels in-flight HTTP; runStepList skips the remaining steps;
          // teardown still runs as cleanup, per the builder contract).
          emitSkippedTree((def.steps ?? []) as StepDef[]);
        } else {
          try {
            if (def.setup) {
              events.emit({ type: "log", id: scope.testMeta.id, message: "Running setup..." });
              state = await def.setup(ctx);
            }
            await runStepList((def.steps ?? []) as StepDef[]);
          } finally {
            // teardown runs even when setup/a step throws (builder contract); its
            // own errors never fail the run (parity with the node harness). (codex P2)
            if (def.teardown) {
              events.emit({ type: "log", id: scope.testMeta.id, message: "Running teardown..." });
              try {
                await def.teardown(ctx, state);
              } catch (e) {
                events.emit({
                  type: "log",
                  id: scope.testMeta.id,
                  message: `Teardown error: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            }
          }
          // A step / branch-predicate called ctx.skip() (recorded without a throw):
          // after teardown the whole test is skipped (node parity: harness.ts:2692).
          // A skip must NOT mask a prior failure: with the `continue` policy an earlier
          // soft-failed step leaves `stepFailed` set while a later step still runs and
          // may skip — the failure wins. (In default fail-fast mode a prior failure
          // already halts the rest, so skipRequest only ever set when stepFailed=false.)
          if (skipRequest && !stepFailed) {
            skipped = true;
            skipReason = skipRequest.reason;
          }
        }
      }
    } catch (e) {
      if (e instanceof SkipError) {
        // ctx.skip() from a simple test (or setup) propagates as a throw → skipped.
        skipped = true;
        skipReason = e.reason;
      } else {
        threw = true;
        thrownError = e instanceof Error ? e.message : String(e);
        thrownStack = e instanceof Error ? e.stack : undefined;
        thrownName = e instanceof Error ? e.name : undefined;
      }
    }

    // The run-level abort signal fired while this run was in flight (`aborted` is only
    // reachable here because the abort happened before the run returned). Force an error
    // verdict even when the steps/body that ran completed — including a final/only step or
    // a simple body that ran out an opaque, non-cancellable await past the abort. A genuine
    // ctx.skip() below still wins (an intentional skip isn't an abort). (codex r1 P2)
    if (scope.signal?.aborted) aborted = true;

    // ctx.skip() wins over any partial assertion bookkeeping: a skipped test has no
    // verdict (the host re-raises its own SkipError(reason) so the dispatcher emits
    // the same skipped status as legacy). assertions are carried for completeness.
    if (skipped) {
      return {
        id: scope.testMeta.id,
        name: def.meta.name ?? def.meta.id,
        status: "skipped",
        ...(skipReason !== undefined ? { skipReason } : {}),
        assertions: { ...scope.assertions },
      };
    }

    // The engine does NOT emit a status EVENT — status emission is host policy:
    // the runner emits "completed" at dispatch (and re-raises a throw so its own
    // dispatcher reports "failed" + exit 1), the browser derives status from the
    // RESULT. Emitting here would force one shape on both hosts and double the
    // runner's status event (plan 0005 / codex P2).
    const assertionsFailed = scope.assertions.total > scope.assertions.passed;
    // Steps tests fail via stepFailed (the LAST attempt of each step) — NOT the
    // cumulative assertion count, so a step that fails then RETRIES to success does
    // not fail the run. Simple tests use the cumulative count (soft-fail).
    const verdict: "ok" | "error" =
      threw || aborted || (def.type === "steps" ? stepFailed : assertionsFailed) ? "error" : "ok";
    return {
      id: scope.testMeta.id,
      name: def.meta.name ?? def.meta.id,
      status: verdict,
      threw,
      // A branch decision failure promotes its message over "One or more steps failed"
      // (node parity: harness throws `branchDecisionError ?? "One or more steps failed"`).
      ...(stepFailed ? { stepsFailed: true, stepsFailMessage: branchDecisionError ?? "One or more steps failed" } : {}),
      // A step failure message wins (most specific); else an abort reads "run aborted";
      // else a soft assertion failure.
      error: verdict === "ok" ? undefined : threw ? thrownError : (stepFailMsg ?? (aborted ? "run aborted" : "assertion failed")),
      // Preserve the user's original throw stack + name so a host can re-raise with
      // them (stack diagnostics + failure classification parity — codex P2).
      ...(threw && thrownStack ? { errorStack: thrownStack } : {}),
      ...(threw && thrownName ? { errorName: thrownName } : {}),
      // The first CAUGHT step/poll failure's error name (a host classifies it; the
      // engine swallowed the throw so `errorName` above stays top-level-only).
      ...(!threw && stepErrorName !== undefined ? { stepErrorName } : {}),
      assertions: { ...scope.assertions },
    };
  }

  private makeCtx(scope: ExecutionScope): EngineContext {
    const emit = (e: Parameters<RunnerServices["events"]["emit"]>[0]) => this.services.events.emit(e);
    // Aggressive array/string truncation of a PASSING assertion's actual/expected,
    // to save tokens (node parity: harness.ts:718 — only on pass, full kept on fail).
    const truncateArrays = this.services.http?.truncateArrays ?? false;
    // Events emitted DURING a step carry its 0-based index (node parity); outside a
    // step (simple tests / setup / teardown) they carry none.
    const emitStep = (e: { stepIndex?: number } & Record<string, unknown>) =>
      emit((scope.currentStepIndex !== null ? { ...e, stepIndex: scope.currentStepIndex } : e) as Parameters<typeof emit>[0]);
    // Extracted so ctx.validate's failure routing reuses the SAME assert/warn paths
    // as ctx.assert / ctx.warn (node parity: harness's runSchemaValidation calls
    // ctx.assert / ctx.warn) — same counters, same stepIndex attribution.
    const assertFn = (condition: unknown, message?: string, details?: unknown): void => {
      const result =
        condition && typeof condition === "object" && "passed" in condition
          ? (condition as { passed: boolean; actual?: unknown; expected?: unknown })
          : { passed: !!condition };
      const d = (details ?? {}) as { actual?: unknown; expected?: unknown };
      // `in` not `??` so an intentional null actual/expected keeps its
      // diagnostic value (codex B4 P3).
      const actual = "actual" in result ? result.actual : d.actual;
      const expected = "expected" in result ? result.expected : d.expected;
      scope.assertions.total += 1;
      if (result.passed) scope.assertions.passed += 1;
      emitStep({
        type: "assertion",
        id: scope.testMeta.id,
        passed: result.passed,
        // Truncate on PASS to save tokens; keep full on FAIL for debugging (node parity).
        actual: result.passed && truncateArrays ? truncateDeep(actual) : actual,
        expected: result.passed && truncateArrays ? truncateDeep(expected) : expected,
        // Parity with the node harness default (gap C).
        message: message ?? (result.passed ? "Assertion passed" : "Assertion failed"),
      });
    };
    const warnFn = (condition: unknown, message?: string): void =>
      // First-class warning event (node parity) — NOT a log. condition=true means OK.
      emitStep({ type: "warning", id: scope.testMeta.id, condition: !!condition, message: message ?? "" });
    // Extracted so ctx.trace's derived action reuses the SAME action path as ctx.action.
    const actionFn = (a: GlubeanAction): void => emitStep({ type: "action", id: scope.testMeta.id, data: a });
    return {
      http: scope.http,
      // Route through assertFn (like the node harness routes expect → ctx.assert,
      // harness.ts:725-737) so the counters, default message, and truncate-on-pass
      // behave identically — one assertion implementation.
      expect: (actual: unknown) =>
        new Expectation(actual, (r: { passed: boolean; actual?: unknown; expected?: unknown; message?: string }) =>
          assertFn({ passed: r.passed, actual: r.actual, expected: r.expected }, r.message),
        ),
      assert: assertFn,
      warn: warnFn,
      validate: <T>(data: unknown, schema: SchemaLike<T>, label?: string, options?: ValidateOptions): T | undefined => {
        const r = runSchemaValidation(data, schema, label ?? "data", options?.severity ?? "error", {
          emitSchemaValidation: (p) => emitStep({ type: "schema_validation", id: scope.testMeta.id, ...p }),
          assert: (passed, msg) => assertFn(passed, msg),
          warn: (cond, msg) => warnFn(cond, msg),
        });
        return r.success ? r.data : undefined;
      },
      vars: {
        get: (k) => scope.runtime.vars[k],
        require: (k, validate) => {
          // Empty = missing (node parity: a "" .env value with no fallback is unset).
          // Check the VALUE, not `k in vars`, since a fallback Proxy may report an
          // empty key as present (codex). Message matches the node harness.
          const v = scope.runtime.vars[k];
          if (v === undefined || v === "") throw new Error(`Missing required var: ${k}`);
          if (validate) runEngineValidator(validate(v), k, "var");
          return v;
        },
        // A copy of all vars (node parity: harness ctx.vars.all → {...rawVars}). Returns
        // the RAW snapshot (host raw map + input overlay), NOT a spread of the fallback
        // Proxy — so empty / overlay-only vars survive identically (codex Phase-8 P2).
        all: () => ({ ...scope.varsAll }),
      },
      secrets: {
        get: (k) => scope.runtime.secrets[k],
        require: (k, validate) => {
          const v = scope.runtime.secrets[k];
          if (v === undefined || v === "") throw new Error(`Missing required secret: ${k}`);
          if (validate) runEngineValidator(validate(v), k, "secret");
          return v;
        },
      },
      session: {
        get: (k) => scope.session[k],
        // node parity: harness.ts:652 — throws with the exact same message.
        require: (k) => {
          const v = scope.session[k];
          if (v === undefined) {
            throw new Error(`Session key '${k}' is required but not set. Check your session.ts setup.`);
          }
          return v;
        },
        set: (k, v) => {
          scope.session[k] = v;
          // Surface the update so a host can propagate it (node: forward to sibling
          // tests; browser: update its store). Without this it'd be lost (codex P2).
          emit({ type: "session_set", id: scope.testMeta.id, key: k, value: v });
        },
        entries: () => ({ ...scope.session }),
      },
      log: (message, data) => emitStep({ type: "log", id: scope.testMeta.id, message, data }),
      // ctx.metric — numeric perf metric. unit/tags are emitted as-is (undefined keys
      // drop on the wire) to match the node harness exactly (harness.ts:818).
      metric: (name: string, value: number, options?: MetricOptions) =>
        emitStep({ type: "metric", id: scope.testMeta.id, name, value, unit: options?.unit, tags: options?.tags }),
      // ctx.action — typed interaction record (node parity: harness.ts:790).
      action: actionFn,
      // ctx.trace — protocol trace event + a derived `{protocol}:request` action
      // (node parity: harness.ts:767-787). The HTTP auto-trace routes through here.
      trace: (request: Trace) => {
        emitStep({ type: "trace", id: scope.testMeta.id, data: request });
        const protocol = request.protocol ?? "http";
        const actionTarget =
          request.target ??
          (request.method && request.url ? `${request.method} ${pathnameOf(request.url)}` : "unknown");
        const actionDuration = request.durationMs ?? request.duration ?? 0;
        const actionOk = request.ok ?? (typeof request.status === "number" && request.status < 400);
        actionFn({
          category: `${protocol}:request`,
          target: actionTarget,
          duration: actionDuration,
          status: actionOk ? "ok" : "error",
          detail: { status: request.status },
        });
      },
      // ctx.event — generic structured event. The workflow first-class unwrap is
      // workflow-only → node-legacy (workflow is never engine-routed), so the engine
      // always emits the generic shape (node parity: harness.ts:804 fall-through).
      event: (ev: GlubeanEvent) => emitStep({ type: "event", id: scope.testMeta.id, data: ev }),
      // ctx.setTimeout(ms) — a CONTROL event (not step-scoped): the parent re-arms its
      // SIGTERM deadline (node parity: harness.ts:898). No stepIndex, like legacy.
      setTimeout: (ms: number) => emit({ type: "timeout_update", id: scope.testMeta.id, timeout: ms }),
      // ctx.pollUntil — poll fn until truthy or timeout; on timeout call onTimeout
      // (silent) or throw (node parity: harness.ts:860). Emits no events itself (fn's
      // assertions emit as usual). Uses the injected clock + setTimeout for the wait.
      pollUntil: async (options: PollUntilOptions, fn: () => Promise<boolean | unknown>): Promise<void> => {
        const { timeoutMs, intervalMs = 1000, onTimeout } = options;
        const deadline = this.services.scheduler.now() + timeoutMs;
        let lastError: Error | undefined;
        while (this.services.scheduler.now() < deadline) {
          // Aborted (run-level signal) — stop polling at once rather than wait out the
          // interval or the full timeout (the in-flight fn's HTTP is cancelled via ky).
          if (scope.signal?.aborted) break;
          try {
            if (await fn()) return; // truthy → done
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
          }
          const remaining = deadline - this.services.scheduler.now();
          if (remaining <= 0) break;
          await abortableSleep(Math.min(intervalMs, remaining), scope.signal);
        }
        // An aborted run did NOT time out — surface the abort accurately (and as a
        // classifiable AbortError) instead of falling through to onTimeout / a "timed out"
        // throw, neither of which is true when the run is being torn down.
        if (scope.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        if (onTimeout) {
          onTimeout(lastError);
          return;
        }
        throw new Error(`pollUntil timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
      },
      // ctx.when(cond, thenFn, elseFn?) — two-way branch; only the taken arm runs
      // (node parity: harness.ts). The cloud dry-run projector overrides this to
      // run both arms; here it is exactly an if/else.
      when: async (
        condition: boolean,
        thenFn: () => void | Promise<void>,
        elseFn?: () => void | Promise<void>,
      ): Promise<void> => {
        if (condition) {
          await thenFn();
        } else if (elseFn) {
          await elseFn();
        }
      },
      // ctx.switch(cases, defaultFn?) — multi-way branch; first truthy lazy guard
      // wins and short-circuits (later guards never run), else defaultFn. Equivalent
      // to an if/else if chain (node parity: harness.ts).
      switch: async (cases: SwitchCase[], defaultFn?: () => void | Promise<void>): Promise<void> => {
        for (const arm of cases) {
          if (arm.when()) {
            await arm.then();
            return;
          }
        }
        if (defaultFn) await defaultFn();
      },
      // ctx.while(cond, body) — `while (cond()) await body();` (node parity: harness
      // ctx.while). The cloud dry-run projector overrides this to run body once.
      while: async (condition: () => boolean, body: () => void | Promise<void>): Promise<void> => {
        while (condition()) {
          await body();
        }
      },
      // ctx.skip(reason?) — throws; the run-loop turns it into a `skipped` verdict.
      skip: (reason?: string): never => {
        throw new SkipError(reason);
      },
      // ctx.fail(message) — emit a failed assertion THEN throw. The assertion is
      // emitted WITHOUT a stepIndex even inside a step (node parity: harness ctx.fail
      // uses the bare emit, not the step-scoped one), but it still bumps the assertion
      // counter so a step/branch leg records the failure even if the throw is caught.
      fail: (message: string): never => {
        scope.assertions.total += 1;
        emit({ type: "assertion", id: scope.testMeta.id, passed: false, message });
        throw new FailError(message);
      },
      retryCount: scope.retryCount,
      // node parity: harness ctx.getMemoryUsage → process.memoryUsage(). Reached via
      // globalThis (NOT a node:* import) so the engine stays browser-safe — null where
      // process.memoryUsage is unavailable (browser).
      getMemoryUsage: () => {
        const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number; heapTotal: number; external: number; rss: number } } }).process;
        return typeof proc?.memoryUsage === "function" ? proc.memoryUsage() : null;
      },
    };
  }
}

type KyResp = ReturnType<KyInstance["get"]>;

/** Resolve a SchemaEntry to {schema, severity} — a bare schema defaults to "error"
 *  (node parity: harness resolveSchemaEntry). */
function resolveSchemaEntry(entry: SchemaEntry<unknown>): {
  schema: SchemaLike<unknown>;
  severity: "error" | "warn" | "fatal";
} {
  if (entry && typeof entry === "object" && "schema" in entry && (entry as { schema?: unknown }).schema != null) {
    const obj = entry as { schema: SchemaLike<unknown>; severity?: "error" | "warn" | "fatal" };
    return { schema: obj.schema, severity: obj.severity ?? "error" };
  }
  return { schema: entry as SchemaLike<unknown>, severity: "error" };
}

/** Normalize a HeadersInit (Headers / plain object / tuple array) → Record<string,
 *  string> for schema validation (node parity: harness normalizeHeadersForValidation). */
function normalizeHeadersForValidation(headers: unknown): Record<string, string> {
  if (headers == null) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2));
  }
  if (typeof headers === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (v != null) out[k] = String(v);
    return out;
  }
  return {};
}

/** Strip a leading '/' from a relative path so ky's `prefix` join works (node parity:
 *  harness normalizeUrl). A protocol-relative '//host' is left intact. */
function normalizeUrl(input: unknown): unknown {
  if (typeof input === "string" && input.startsWith("/") && !input.startsWith("//")) return input.slice(1);
  return input;
}

/**
 * Wrap a per-run ky instance into the public ctx.http facade. A Proxy preserves the
 * full KyInstance surface and adds, on calls + `.extend()`:
 *  - prefixUrl → ky 2 `prefix` + empty-searchParams removal (node parity: harness
 *    normalizeOptions / normalizeUrl).
 *  - automatic schema validation: request body / query / request headers BEFORE the
 *    request, response headers via an injected afterResponse hook, and response body
 *    by monkey-patching the response promise's `.json()` — all routed through the
 *    run's ctx.validate (→ schema_validation event + severity routing), node parity:
 *    harness wrapKy / runPreRequestSchemaValidation / wrapResponseWithSchema.
 */
function wrapScopedKy(
  instance: KyInstance,
  scope: ExecutionScope,
  abortMode: "precise" | "coarse",
): GlubeanHttp {
  // prefixUrl → ky 2 `prefix`, and drop an empty searchParams (no bare '?'). `schema`
  // is RETAINED here (callWithSchema reads it, then strips it before handing to ky).
  const normalizeKyOptions = (opts: unknown): Record<string, unknown> | undefined => {
    if (!opts || typeof opts !== "object") return opts as undefined;
    const n: Record<string, unknown> = { ...(opts as Record<string, unknown>) };
    if ("prefixUrl" in n) {
      n.prefix = n.prefixUrl;
      delete n.prefixUrl;
    }
    const sp = n.searchParams;
    if (sp != null) {
      const empty =
        (typeof URLSearchParams !== "undefined" && sp instanceof URLSearchParams && sp.toString() === "") ||
        (typeof sp === "string" && sp === "") ||
        (typeof sp === "object" && !(sp instanceof URLSearchParams) && !Array.isArray(sp) && Object.keys(sp as object).length === 0);
      if (empty) delete n.searchParams;
    }
    return n;
  };

  // Route a schema validation through the run's ctx (→ schema_validation event +
  // severity routing). A request before makeCtx never happens during a run, so the
  // optional-chain is just defensive.
  const validate = (data: unknown, entry: SchemaEntry<unknown>, label: string): void => {
    const { schema, severity } = resolveSchemaEntry(entry);
    scope.ctxRef?.validate(data, schema, label, { severity });
  };

  const preRequest = (opts: Record<string, unknown> | undefined): void => {
    const schemaOpts = opts?.schema as HttpSchemaOptions | undefined;
    if (!schemaOpts) return;
    if (schemaOpts.query && opts?.searchParams != null) validate(opts.searchParams, schemaOpts.query, "query params");
    if (schemaOpts.request && opts?.json !== undefined) validate(opts.json, schemaOpts.request, "request body");
    if (schemaOpts.requestHeaders && opts?.headers != null) {
      validate(normalizeHeadersForValidation(opts.headers), schemaOpts.requestHeaders, "request headers");
    }
  };

  // Strip the non-ky `schema` option, injecting a response-headers afterResponse hook
  // when a responseHeaders schema is present (fires once per final response).
  const toKyOptions = (opts: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!opts) return opts;
    const schemaOpts = opts.schema as HttpSchemaOptions | undefined;
    const { schema: _schema, ...rest } = opts;
    let kyOptions: Record<string, unknown> = rest;
    if (schemaOpts?.responseHeaders) {
      const entry = schemaOpts.responseHeaders;
      const hook = ({ response }: { response: Response }) =>
        validate(normalizeHeadersForValidation(response.headers), entry, "response headers");
      const hooks = (kyOptions.hooks ?? {}) as { afterResponse?: unknown[] };
      kyOptions = { ...kyOptions, hooks: { ...hooks, afterResponse: [...(hooks.afterResponse ?? []), hook] } };
    }
    return kyOptions;
  };

  // Monkey-patch the ky ResponsePromise's `.json()` shortcut to validate the parsed
  // body. EXACT node-harness parity (harness.ts:1249-1268): only the promise shortcut
  // (`http.get(url, {schema}).json()`) is patched, NOT the resolved Response — so an
  // `await`-first-then-`res.json()` flow bypasses response-schema validation on BOTH
  // legs identically (codex 4f P2). This is a shared legacy limitation, not an engine
  // divergence; "fixing" it engine-only would break byte-parity. Any real fix must
  // land in both legs (post-cutover), so the engine intentionally mirrors legacy here.
  const wrapResponse = (promise: KyResp, opts: Record<string, unknown> | undefined): KyResp => {
    const schemaOpts = opts?.schema as HttpSchemaOptions | undefined;
    if (!schemaOpts?.response) return promise;
    const entry = schemaOpts.response;
    const originalJson = promise.json.bind(promise);
    (promise as { json: typeof originalJson }).json = async <J = unknown>() => {
      const body = await originalJson();
      validate(body, entry, "response body");
      return body as J;
    };
    return promise;
  };

  // Hand the run-level abort signal (ScopeInput.signal) to ky so an aborted run cancels
  // its in-flight requests. If the caller already has their OWN signal, compose both so
  // either can abort. ky resolves the caller's signal as `options.signal ?? input.signal`
  // (a `Request` may carry its own), so mirror that precedence here — else injecting our
  // signal as `options.signal` would silently drop a Request-level signal (codex r1 P2).
  // On a runtime without AbortSignal.any, keep the caller's (their abort must not regress
  // — the run signal still covers every other request). No run signal → input untouched.
  //
  // PERF (load footgun): the run signal is LONG-LIVED (whole run). Handing it to ky on
  // every request makes ky/undici attach an abort listener to it per request; those
  // accumulate, so each later signal op goes O(n) and a high-RPS run gets progressively
  // slower (profiled at ~half of Node CPU under load). Fix: bridge the long-lived run
  // signal to ONE per-iteration controller — a single listener, removed when the
  // iteration settles (scope.disposeHttp) — and hand ky that short-lived per-iteration
  // signal. `abortMode: "coarse"` skips the wiring entirely (abort handled between steps).
  // The bridge controller lives on the SCOPE, not this closure, so the base ky and every
  // ctx.http.extend(...) client share ONE controller — and add exactly ONE listener to the
  // long-lived run signal per iteration (codex: per-closure state would re-leak via extend).
  const iterationSignal = (runSignal: AbortSignal): AbortSignal => {
    if (runSignal.aborted) return runSignal; // already aborted: nothing to bridge
    if (!scope.httpAbort) {
      const ac = new AbortController();
      scope.httpAbort = ac;
      const onAbort = (): void => ac.abort((runSignal as { reason?: unknown }).reason);
      runSignal.addEventListener("abort", onAbort, { once: true });
      const prev = scope.disposeHttp;
      scope.disposeHttp = (): void => {
        // Abort the per-iteration controller FIRST: once we drop the run-signal listener,
        // nothing else can cancel a request still in flight (e.g. a step that timed out
        // while its ky call kept running). Aborting here cancels such stragglers at
        // iteration settle; it's a no-op when every request already completed.
        if (!ac.signal.aborted) ac.abort();
        runSignal.removeEventListener("abort", onAbort);
        prev?.();
      };
    }
    return scope.httpAbort.signal;
  };
  const injectSignal = (
    rawInput: unknown,
    opts: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    const runSignal = scope.signal;
    if (!runSignal || abortMode === "coarse") return opts;
    const optsSignal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    const reqSignal = typeof Request !== "undefined" && rawInput instanceof Request ? rawInput.signal : undefined;
    const own = optsSignal ?? reqSignal; // ky's own precedence: options.signal ?? input.signal
    const runSig = iterationSignal(runSignal);
    if (!own) return { ...(opts ?? {}), signal: runSig };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
      return { ...(opts ?? {}), signal: AbortSignal.any([own, runSig]) };
    }
    return opts;
  };

  const callWithSchema = (
    kyCall: (url: unknown, opts?: unknown) => KyResp,
    input: unknown,
    opts?: unknown,
  ): KyResp => {
    const normalized = normalizeKyOptions(opts);
    preRequest(normalized);
    const promise = kyCall(normalizeUrl(input), injectSignal(input, toKyOptions(normalized)));
    return wrapResponse(promise, normalized);
  };

  return new Proxy(instance, {
    apply: (target, _thisArg, args: unknown[]) =>
      callWithSchema((u, o) => (target as unknown as (...a: unknown[]) => KyResp)(u, o), args[0], args[1]),
    get: (target, prop, recv) => {
      if (prop === "extend") {
        return (opts: unknown) =>
          wrapScopedKy(
            target.extend(
              typeof opts === "function"
                ? (((parent: unknown) => normalizeKyOptions((opts as (p: unknown) => unknown)(parent))) as never)
                : (normalizeKyOptions(opts) as never),
            ),
            scope,
            abortMode,
          );
      }
      const value = Reflect.get(target, prop, recv);
      if (typeof value === "function" && typeof prop === "string" && HTTP_METHODS.has(prop)) {
        return (url: unknown, opts?: unknown) =>
          callWithSchema((u, o) => (value as (...a: unknown[]) => KyResp).call(target, u, o), url, opts);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as GlubeanHttp;
}

// --- resolve helpers: map SDK module exports → engine TestDef -----------------
// Structural shape of an SDK Test (we avoid importing the heavy generic type).
export interface SdkTestShape {
  meta: { id: string; name?: string; tags?: string[] | string; skip?: boolean; only?: boolean };
  type: "simple" | "steps";
  fn?: unknown;
  setup?: unknown;
  steps?: unknown;
  teardown?: unknown;
}

// Only the Stage-1 supported markers — a `workflow-builder` also has __glubean_type
// + build(), but the narrow engine has no workflow ctx, so building it would yield
// a def that fails at runtime. Leave workflows unresolved until Stage 2. (codex B4 P2)
function isBuilder(v: unknown): v is { __glubean_type: string; build(): unknown } {
  const marker = (v as { __glubean_type?: unknown })?.__glubean_type;
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { build?: unknown }).build === "function" &&
    (marker === "builder" || marker === "each-builder")
  );
}

function isSdkTest(v: unknown): v is SdkTestShape {
  return (
    !!v &&
    typeof v === "object" &&
    "meta" in v &&
    "type" in v &&
    ((v as SdkTestShape).type === "simple" || (v as SdkTestShape).type === "steps")
  );
}

// TestBuilder → Test, EachBuilder → Test[]. Otherwise pass through (workflow
// builders are NOT built — see isBuilder).
function autoResolveDef(v: unknown): unknown {
  return isBuilder(v) ? v.build() : v;
}

// A built workflow handle is an array tagged __glubean_type "workflow" (builder.ts).
// Workflows are Stage 2 (no workflow ctx here), so exclude them entirely. (codex B4 P2)
function isWorkflowHandle(v: unknown): boolean {
  return !!v && typeof v === "object" && (v as { __glubean_type?: unknown }).__glubean_type === "workflow";
}

// test.extend() tests carry a non-empty `fixtures` map. Fixtures are Stage 2;
// excluding keeps us from running an extended test without its fixtures. (codex B4 P2)
function hasFixtures(v: unknown): boolean {
  const f = (v as { fixtures?: unknown })?.fixtures;
  return !!f && typeof f === "object" && Object.keys(f as object).length > 0;
}

// A resolved value the narrow Stage-1 engine can actually run.
function pushIfRunnable(v: unknown, out: TestDef[]): void {
  if (isWorkflowHandle(v) || !isSdkTest(v) || hasFixtures(v)) return;
  out.push(toTestDef(v));
}

function collectDefs(value: unknown, out: TestDef[]): void {
  if (isWorkflowHandle(value)) return;
  const resolved = autoResolveDef(value);
  if (isWorkflowHandle(resolved)) return;
  if (isSdkTest(resolved)) {
    pushIfRunnable(resolved, out);
    return;
  }
  if (Array.isArray(resolved)) {
    for (const item of resolved) {
      if (isWorkflowHandle(item)) continue;
      const r = autoResolveDef(item);
      if (isWorkflowHandle(r)) continue;
      if (Array.isArray(r)) {
        for (const inner of r) pushIfRunnable(inner, out);
      } else {
        pushIfRunnable(r, out);
      }
    }
  }
}

export function toTestDef(t: SdkTestShape): TestDef {
  const tags = Array.isArray(t.meta.tags) ? t.meta.tags : typeof t.meta.tags === "string" ? [t.meta.tags] : undefined;
  // SDK step fns take the SDK TestContext; the engine provides the narrow subset
  // at runtime, so the cast is sound for the Stage-1 surface.
  return {
    meta: { id: t.meta.id, name: t.meta.name, tags, skip: t.meta.skip, only: t.meta.only },
    type: t.type,
    fn: t.fn as TestFn | undefined,
    setup: t.setup as TestFn | undefined,
    steps: t.steps as { meta: { name: string }; fn: TestFn }[] | undefined,
    teardown: t.teardown as TestFn | undefined,
  };
}
