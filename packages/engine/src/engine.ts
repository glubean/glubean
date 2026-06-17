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
import { Expectation } from "@glubean/sdk";
import { installCarrier, runWithRuntime } from "@glubean/sdk/internal";
import type { InternalRuntime } from "@glubean/sdk/internal";
import type {
  EngineContext,
  ExecutionScope,
  GlubeanHttp,
  RunnerServices,
  ScopeInput,
  TestDef,
  TestFn,
  TestResult,
} from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);

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

/** Per-step timeout error — same message/name as the node harness (harness.ts:446)
 *  so step_end.error + classifyErrorReason match. */
class StepTimeoutError extends Error {
  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
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
    return runWithRuntime(scope.runtime, () => this.runLoop(def, scope));
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
    };
    const http = this.createScopedKy(def.meta.id, () => scope.currentStepIndex);
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
    };
    return scope;
  }

  /**
   * Build a per-run ky instance: host fetch + scope-bound trace hooks. Trace is
   * keyed by the Request object (per-scope WeakMap), NOT ky NormalizedOptions
   * (codex P1-2: ky 2 strips ky options from hook state). throwHttpErrors:false
   * matches the node harness default so 4xx/5xx surface as responses, not throws.
   */
  private createScopedKy(testId: string, getStepIndex: () => number | null): GlubeanHttp {
    const { fetch: hostFetch, events, scheduler } = this.services;
    const startedAt = new WeakMap<Request, number>();
    const instance = ky.create({
      fetch: hostFetch as typeof fetch,
      throwHttpErrors: false,
      // Match the node harness default: no implicit retries (authors opt in
      // per-request). ky 2 retries GET/HEAD by default, which would mask
      // transient failures and emit extra requests/traces. (codex engine P2)
      retry: 0,
      hooks: {
        beforeRequest: [
          ({ request }) => {
            startedAt.set(request, scheduler.now());
          },
        ],
        afterResponse: [
          ({ request, response }) => {
            const t0 = startedAt.get(request) ?? scheduler.now();
            const stepIndex = getStepIndex();
            events.emit({
              type: "trace",
              id: testId,
              method: request.method,
              url: request.url,
              status: response.status,
              timeMs: scheduler.now() - t0,
              ...(stepIndex !== null ? { stepIndex } : {}),
            });
          },
        ],
      },
    });
    return withPrefixUrlAlias(instance);
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

    let threw = false;
    let thrownError: string | undefined;
    let thrownStack: string | undefined;
    let thrownName: string | undefined;
    // A step that throws is CAUGHT + recorded as a failed step (node parity: the
    // run still "completes"); it must still make the test's verdict error.
    let stepFailed = false;
    let stepFailMsg: string | undefined;
    try {
      if (def.type === "simple") {
        if (!def.fn) throw new Error(`test "${def.meta.id}": missing fn`);
        await def.fn(ctx);
      } else {
        let state: unknown;
        const stepTotal = def.steps?.length ?? 0;
        try {
          if (def.setup) {
            events.emit({ type: "log", id: scope.testMeta.id, message: "Running setup..." });
            state = await def.setup(ctx);
          }
          let i = 0;
          for (const step of def.steps ?? []) {
            const idx = i++;
            // A prior step failed → skip the rest, emitting a skipped step_end for
            // each (node parity: emitSkippedTree — no attempts/retriesUsed).
            if (stepFailed) {
              events.emit({
                type: "step_end",
                id: scope.testMeta.id,
                index: idx,
                name: step.meta.name,
                status: "skipped",
                durationMs: 0,
                assertions: 0,
                failedAssertions: 0,
              });
              continue;
            }
            scope.currentStepIndex = idx;
            const startedAt = scheduler.now();
            events.emit({ type: "step_start", id: scope.testMeta.id, index: idx, name: step.meta.name, total: stepTotal });

            // Per-step retry / timeout (node parity, harness runStepList). retries
            // re-run the fn on failure — NOT on a timeout (terminal). backoff delay =
            // retryDelay * backoff^(attempt-1), capped at 30s.
            const sm = (step as { meta?: { retries?: number; retryDelay?: number; backoff?: number; timeout?: number } }).meta ?? {};
            const configuredRetries = Number.isFinite(sm.retries) ? Math.max(0, Math.floor(sm.retries as number)) : 0;
            const retryDelayMs = Number.isFinite(sm.retryDelay) ? Math.max(0, sm.retryDelay as number) : configuredRetries > 0 ? 1000 : 0;
            const backoff = Number.isFinite(sm.backoff) ? Math.max(1, sm.backoff as number) : 1;
            const stepTimeoutMs = Number.isFinite(sm.timeout) && (sm.timeout as number) > 0 ? Math.floor(sm.timeout as number) : undefined;
            const maxAttempts = configuredRetries + 1;

            let stepError: string | undefined;
            let stepReturnState: unknown;
            let attemptsUsed = 0;
            let lastAssertions = 0;
            let lastFailedAssertions = 0;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              attemptsUsed = attempt;
              stepError = undefined;
              stepReturnState = undefined;
              const aBefore = scope.assertions.total;
              const fBefore = scope.assertions.total - scope.assertions.passed;
              let timedOut = false;
              try {
                const call = step.fn(ctx, state);
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
                // A thrown step is caught + recorded as a failed step (node parity:
                // the run still "completes"; the test fails via stepsFailed).
                stepError = e instanceof Error ? e.message : String(e);
                timedOut = e instanceof StepTimeoutError;
              }
              lastAssertions = scope.assertions.total - aBefore;
              lastFailedAssertions = scope.assertions.total - scope.assertions.passed - fBefore;
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
                if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
              }
            }

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

            // On failure: mark stepFailed but DON'T break — the loop continues so the
            // remaining steps emit skipped step_end (node parity, skip-check at top).
            if (failed) {
              stepFailed = true;
              if (stepError && stepFailMsg === undefined) stepFailMsg = stepError;
            }
          }
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
      }
    } catch (e) {
      threw = true;
      thrownError = e instanceof Error ? e.message : String(e);
      thrownStack = e instanceof Error ? e.stack : undefined;
      thrownName = e instanceof Error ? e.name : undefined;
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
      threw || (def.type === "steps" ? stepFailed : assertionsFailed) ? "error" : "ok";
    return {
      id: scope.testMeta.id,
      name: def.meta.name ?? def.meta.id,
      status: verdict,
      threw,
      ...(stepFailed ? { stepsFailed: true } : {}),
      error: verdict === "ok" ? undefined : threw ? thrownError : (stepFailMsg ?? "assertion failed"),
      // Preserve the user's original throw stack + name so a host can re-raise with
      // them (stack diagnostics + failure classification parity — codex P2).
      ...(threw && thrownStack ? { errorStack: thrownStack } : {}),
      ...(threw && thrownName ? { errorName: thrownName } : {}),
      assertions: { ...scope.assertions },
    };
  }

  private makeCtx(scope: ExecutionScope): EngineContext {
    const emit = (e: Parameters<RunnerServices["events"]["emit"]>[0]) => this.services.events.emit(e);
    // Events emitted DURING a step carry its 0-based index (node parity); outside a
    // step (simple tests / setup / teardown) they carry none.
    const emitStep = (e: { stepIndex?: number } & Record<string, unknown>) =>
      emit((scope.currentStepIndex !== null ? { ...e, stepIndex: scope.currentStepIndex } : e) as Parameters<typeof emit>[0]);
    return {
      http: scope.http,
      expect: (actual: unknown) =>
        new Expectation(actual, (r: { passed: boolean; actual?: unknown; expected?: unknown; message?: string }) => {
          scope.assertions.total += 1;
          if (r.passed) scope.assertions.passed += 1;
          emitStep({
            type: "assertion",
            id: scope.testMeta.id,
            passed: r.passed,
            actual: r.actual,
            expected: r.expected,
            // Default to the node harness's wording so both hosts + the runner
            // golden agree on the message when the matcher gave none (parity gap C).
            message: r.message ?? (r.passed ? "Assertion passed" : "Assertion failed"),
          });
        }),
      assert: (condition: unknown, message?: string, details?: unknown) => {
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
          actual,
          expected,
          // Parity with the node harness default (gap C).
          message: message ?? (result.passed ? "Assertion passed" : "Assertion failed"),
        });
      },
      warn: (condition: unknown, message?: string) =>
        // First-class warning event (node parity) — NOT a log. condition=true means OK.
        emitStep({ type: "warning", id: scope.testMeta.id, condition: !!condition, message: message ?? "" }),
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
        set: (k, v) => {
          scope.session[k] = v;
          // Surface the update so a host can propagate it (node: forward to sibling
          // tests; browser: update its store). Without this it'd be lost (codex P2).
          emit({ type: "session_set", id: scope.testMeta.id, key: k, value: v });
        },
      },
      log: (message, data) => emitStep({ type: "log", id: scope.testMeta.id, message, data }),
      retryCount: scope.retryCount,
    };
  }
}

/**
 * Preserve Glubean's public `prefixUrl` option over ky 2 (which renamed it to
 * `prefix`). A Proxy over the real ky instance keeps the full KyInstance surface
 * and only rewrites `prefixUrl` → `prefix` on calls and `.extend()` (codex P2-5).
 * `prefix` (not `baseUrl`) preserves the ky-1 join semantics for "users" / "/users".
 */
function withPrefixUrlAlias(instance: KyInstance): GlubeanHttp {
  const mapOpts = (opts: unknown): unknown => {
    if (opts && typeof opts === "object" && "prefixUrl" in opts) {
      const { prefixUrl, ...rest } = opts as Record<string, unknown>;
      return { ...rest, prefix: prefixUrl };
    }
    return opts;
  };
  return new Proxy(instance, {
    apply: (target, _thisArg, args: unknown[]) =>
      (target as unknown as (...a: unknown[]) => unknown)(args[0], mapOpts(args[1])),
    get: (target, prop, recv) => {
      if (prop === "extend") {
        return (opts: unknown) =>
          withPrefixUrlAlias(
            target.extend(
              typeof opts === "function"
                ? (((parent: unknown) => mapOpts((opts as (p: unknown) => unknown)(parent))) as never)
                : (mapOpts(opts) as never),
            ),
          );
      }
      const value = Reflect.get(target, prop, recv);
      if (typeof value === "function" && typeof prop === "string" && HTTP_METHODS.has(prop)) {
        return (url: unknown, opts?: unknown) =>
          (value as (...a: unknown[]) => unknown).call(target, url, mapOpts(opts));
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
