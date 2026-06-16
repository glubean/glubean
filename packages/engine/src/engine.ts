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
  RunnerServices,
  ScopeInput,
  TestDef,
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
    const scope = this.createScope(def, input);
    return runWithRuntime(scope.runtime, () => this.runLoop(def, scope));
  }

  private createScope(def: TestDef, input: ScopeInput): ExecutionScope {
    const { env, events, scheduler } = this.services;
    const vars = { ...env.vars(), ...(input.vars ?? {}) };
    const secrets = { ...env.secrets(), ...(input.secrets ?? {}) };
    const session: Record<string, unknown> = { ...(input.session ?? {}) };

    const http = this.createScopedKy();

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
      log: (message: string, data?: unknown) => events.emit({ type: "log", message, data }),
    };
    return scope;
  }

  /**
   * Build a per-run ky instance: host fetch + scope-bound trace hooks. Trace is
   * keyed by the Request object (per-scope WeakMap), NOT ky NormalizedOptions
   * (codex P1-2: ky 2 strips ky options from hook state). throwHttpErrors:false
   * matches the node harness default so 4xx/5xx surface as responses, not throws.
   */
  private createScopedKy(): KyInstance {
    const { fetch: hostFetch, events, scheduler } = this.services;
    const startedAt = new WeakMap<Request, number>();
    const instance = ky.create({
      fetch: hostFetch as typeof fetch,
      throwHttpErrors: false,
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
            const next = await step.fn(ctx, state);
            if (next !== undefined) state = next;
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
          emit({ type: "assertion", passed: r.passed, actual: r.actual, expected: r.expected, message: r.message });
        }),
      vars: {
        get: (k) => scope.runtime.vars[k],
        require: (k) => {
          if (!(k in scope.runtime.vars)) throw new Error(`missing var "${k}"`);
          return scope.runtime.vars[k];
        },
      },
      session: {
        get: (k) => scope.session[k],
        set: (k, v) => {
          scope.session[k] = v;
        },
      },
      log: (message, data) => emit({ type: "log", message, data }),
    };
  }
}

/**
 * Preserve Glubean's public `prefixUrl` option over ky 2 (which renamed it to
 * `prefix`). A Proxy over the real ky instance keeps the full KyInstance surface
 * and only rewrites `prefixUrl` → `prefix` on calls and `.extend()` (codex P2-5).
 * `prefix` (not `baseUrl`) preserves the ky-1 join semantics for "users" / "/users".
 */
function withPrefixUrlAlias(instance: KyInstance): KyInstance {
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
            target.extend(typeof opts === "function" ? (opts as never) : (mapOpts(opts) as never)),
          );
      }
      const value = Reflect.get(target, prop, recv);
      if (typeof value === "function" && typeof prop === "string" && HTTP_METHODS.has(prop)) {
        return (url: unknown, opts?: unknown) =>
          (value as (...a: unknown[]) => unknown).call(target, url, mapOpts(opts));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as KyInstance;
}
