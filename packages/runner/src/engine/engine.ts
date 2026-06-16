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
 * Narrow run-loop only: simple + linear steps. No branch / poll / retry / timeout
 * / workflow (Stage 2).
 */
import { Expectation } from "@glubean/sdk";
import { installCarrier, runWithRuntime } from "@glubean/sdk/internal";
import type { InternalRuntime } from "@glubean/sdk/internal";
import type {
  EngineContext,
  ExecutionScope,
  ExtendOpts,
  HttpCallOpts,
  HttpClientLike,
  HttpResponseData,
  ResponseLike,
  ResponsePromise,
  RunnerServices,
  ScopeInput,
  TestDef,
  TestResult,
  Transport,
} from "./types.js";

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
    const { env, transport, events, scheduler } = this.services;
    const vars = { ...env.vars(), ...(input.vars ?? {}) };
    const secrets = { ...env.secrets(), ...(input.secrets ?? {}) };
    const session: Record<string, unknown> = { ...(input.session ?? {}) };

    const http = createHttpFacade({
      transport,
      emit: (e) => events.emit(e),
      now: () => scheduler.now(),
    });

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
        if (def.setup) state = await def.setup(ctx);
        for (const step of def.steps ?? []) {
          scope.stepIndex += 1;
          const next = await step.fn(ctx, state);
          if (next !== undefined) state = next;
        }
        if (def.teardown) {
          try {
            await def.teardown(ctx, state);
          } catch {
            /* teardown errors don't fail the run (parity with node harness) */
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

// --- minimal scope-bound HttpFacade over the injected Transport ---------------
// ky-shaped enough for configure().http (extend + methods + ResponsePromise),
// emitting a scope-attributed trace per request. NOT full HttpFacade parity
// (Stage 2); just the surface the carrier proof needs (codex Track A P2-2).

interface FacadeConfig {
  transport: Transport;
  emit: (e: { type: "trace"; method: string; url: string; status: number; timeMs: number }) => void;
  now: () => number;
  prefixUrl?: string;
  headers?: Record<string, string>;
}

function createHttpFacade(cfg: FacadeConfig): HttpClientLike {
  const call = (defaultMethod: string) => (url: string, opts: HttpCallOpts = {}): ResponsePromise => {
    const method = (opts.method ?? defaultMethod).toUpperCase();
    const finalUrl = cfg.prefixUrl ? joinUrl(cfg.prefixUrl, url) : url;
    const headers: Record<string, string> = { ...(cfg.headers ?? {}), ...(opts.headers ?? {}) };
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
    const t0 = cfg.now();
    const promise = cfg.transport.request({ method, url: finalUrl, headers, body }).then((res) => {
      cfg.emit({ type: "trace", method, url: finalUrl, status: res.status, timeMs: res.timeMs ?? cfg.now() - t0 });
      return toResponseLike(res);
    });
    return makeResponsePromise(promise);
  };

  const http = ((url: string, opts?: HttpCallOpts) => call((opts?.method ?? "GET"))(url, opts)) as HttpClientLike;
  http.get = call("GET");
  http.post = call("POST");
  http.put = call("PUT");
  http.patch = call("PATCH");
  http.delete = call("DELETE");
  http.head = call("HEAD");
  http.extend = (ext: ExtendOpts) =>
    createHttpFacade({
      ...cfg,
      prefixUrl: typeof ext.prefixUrl === "string" ? ext.prefixUrl : cfg.prefixUrl,
      headers: { ...(cfg.headers ?? {}), ...(ext.headers ?? {}) },
    });
  return http;
}

function makeResponsePromise(p: Promise<ResponseLike>): ResponsePromise {
  const rp = p as ResponsePromise;
  rp.json = () => p.then((r) => r.json());
  rp.text = () => p.then((r) => r.text());
  return rp;
}

function toResponseLike(res: HttpResponseData): ResponseLike {
  const hget = (k: string) => {
    const hit = (res.headers ?? []).find(([hk]) => hk.toLowerCase() === String(k).toLowerCase());
    return hit ? hit[1] : null;
  };
  return {
    status: res.status,
    statusText: res.statusText ?? "",
    ok: res.status >= 200 && res.status < 300,
    headers: { get: hget },
    json: async () => JSON.parse(res.body || "null"),
    text: async () => res.body || "",
  };
}

function joinUrl(prefix: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url; // absolute wins
  return `${prefix.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}
