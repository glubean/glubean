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
      this.services.events.emit({ type: "status", id: def.meta.id, status: "skipped" });
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
    const { env, events, scheduler } = this.services;
    const vars = { ...env.vars(), ...(input.vars ?? {}) };
    const secrets = { ...env.secrets(), ...(input.secrets ?? {}) };
    const session: Record<string, unknown> = { ...(input.session ?? {}) };

    const http = this.createScopedKy(def.meta.id);

    const scope: ExecutionScope = {
      runtime: undefined as unknown as InternalRuntime,
      testMeta: { id: def.meta.id, tags: def.meta.tags ?? [] },
      stepIndex: 0,
      assertions: { total: 0, passed: 0 },
      http,
      session,
    };

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
  private createScopedKy(testId: string): GlubeanHttp {
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
            events.emit({
              type: "trace",
              id: testId,
              method: request.method,
              url: request.url,
              status: response.status,
              timeMs: scheduler.now() - t0,
            });
          },
        ],
      },
    });
    return withPrefixUrlAlias(instance);
  }

  private async runLoop(def: TestDef, scope: ExecutionScope): Promise<TestResult> {
    const { events } = this.services;
    events.emit({ type: "start", id: scope.testMeta.id, name: def.meta.name ?? def.meta.id, tags: scope.testMeta.tags });
    const ctx = this.makeCtx(scope);

    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    try {
      if (def.type === "simple") {
        if (!def.fn) throw new Error(`test "${def.meta.id}": missing fn`);
        await def.fn(ctx);
      } else {
        let state: unknown;
        try {
          if (def.setup) state = await def.setup(ctx);
          for (const step of def.steps ?? []) {
            scope.stepIndex += 1;
            const failedBefore = scope.assertions.total - scope.assertions.passed;
            const next = await step.fn(ctx, state);
            if (next !== undefined) state = next;
            // Stop after a soft assertion failure in this step — later steps are
            // skipped so they can't run side effects (node harness parity). A
            // thrown step already exits via the outer catch. (codex engine P2)
            if (scope.assertions.total - scope.assertions.passed > failedBefore) break;
          }
        } finally {
          // teardown runs even when setup/a step throws (builder contract); its
          // own errors never fail the run (parity with the node harness). (codex P2)
          if (def.teardown) {
            try {
              await def.teardown(ctx, state);
            } catch {
              /* swallow */
            }
          }
        }
      }
      if (scope.assertions.total > scope.assertions.passed) {
        status = "error";
        error = "assertion failed";
      }
    } catch (e) {
      status = "error";
      error = e instanceof Error ? e.message : String(e);
    }

    events.emit({ type: "status", id: scope.testMeta.id, status, error });
    return {
      id: scope.testMeta.id,
      name: def.meta.name ?? def.meta.id,
      status,
      error,
      assertions: { ...scope.assertions },
    };
  }

  private makeCtx(scope: ExecutionScope): EngineContext {
    const emit = (e: Parameters<RunnerServices["events"]["emit"]>[0]) => this.services.events.emit(e);
    return {
      http: scope.http,
      expect: (actual: unknown) =>
        new Expectation(actual, (r: { passed: boolean; actual?: unknown; expected?: unknown; message?: string }) => {
          scope.assertions.total += 1;
          if (r.passed) scope.assertions.passed += 1;
          emit({
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
        emit({
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
        emit({ type: "log", id: scope.testMeta.id, message: `[warn] ${message ?? ""}`, data: { passed: !!condition } }),
      vars: {
        get: (k) => scope.runtime.vars[k],
        require: (k) => {
          if (!(k in scope.runtime.vars)) throw new Error(`missing var "${k}"`);
          return scope.runtime.vars[k];
        },
      },
      secrets: {
        get: (k) => scope.runtime.secrets[k],
        require: (k) => {
          if (!(k in scope.runtime.secrets)) throw new Error(`missing secret "${k}"`);
          return scope.runtime.secrets[k];
        },
      },
      session: {
        get: (k) => scope.session[k],
        set: (k, v) => {
          scope.session[k] = v;
        },
      },
      log: (message, data) => emit({ type: "log", id: scope.testMeta.id, message, data }),
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
interface SdkTestShape {
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

function toTestDef(t: SdkTestShape): TestDef {
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
