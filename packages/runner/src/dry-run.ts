/**
 * Dry-run projection (C2 / P2) — execute a simple test's function body with a
 * SYNTHETIC context that records its SHAPE (assertions made, endpoints hit)
 * without performing any real I/O. Powers `glubean dry-run`, whose output feeds
 * the cloud "test definition" team-review view.
 *
 * This is a SEPARATE execution path from the runner harness and from the
 * scanner: the scanner never executes user code (pure AST), while dry-run DOES
 * import + invoke the test body. The synthetic ctx makes that safe — every
 * effect is intercepted — and a request budget breaks data-dependent loops.
 *
 * Branch completeness: native `if`/`switch` only reveals the one arm the
 * synthetic response happens to take, so authors should use `ctx.when()` /
 * `ctx.switch()`, which the projector runs EXHAUSTIVELY (every arm, branch-
 * tagged). The scanner's `bareBranchCount` is folded in to mark a projection
 * partial when bare branches remain.
 */

import type { Test, TestContext, SwitchCase } from "@glubean/sdk";

/** A single recorded assertion intent. */
export interface ProjAssertion {
  /** assert | expect.<matcher> | fail | validate */
  kind: string;
  message?: string;
  /** Branch path, e.g. "when#0:then" or "switch#1:case[2]" (nested joined by ">"). */
  branch?: string;
}

/** A single recorded endpoint hit. */
export interface ProjEndpoint {
  method: string;
  url: string;
  branch?: string;
}

/** The projected shape of one test — what it verifies and what it touches. */
export interface TestShape {
  testId: string;
  exportName: string;
  assertions: ProjAssertion[];
  endpoints: ProjEndpoint[];
  assertionCount: number;
  /**
   * True when the projector captured the test's full shape. False when a bare
   * `if`/`switch` remained (only one arm followed), the request budget broke a
   * loop, the body threw, or the test isn't a simple test.
   */
  projectionComplete: boolean;
  /** Human-readable reason when `projectionComplete` is false. */
  incompleteReason?: string;
  /** True when the body called `ctx.skip()`. */
  skipped?: boolean;
}

/** Breaker for data-dependent loops (synthetic guards are perpetually truthy). */
const REQUEST_BUDGET = 50;

class DryRunBudgetExceeded extends Error {}
class DryRunSkip extends Error {}

/**
 * A value that survives arbitrary property access, calls, await, and iteration
 * so a test body can run to completion against it without throwing. Numeric/
 * string coercion yields 0/""; iteration yields nothing; `then` is absent so
 * awaiting it returns the proxy itself (not a hang).
 */
function makeSyntheticResponse(): any {
  const target = function () {};
  const handler: ProxyHandler<any> = {
    get(_t, prop) {
      if (prop === "then") return undefined; // not thenable → await yields the proxy
      if (prop === Symbol.toPrimitive) return () => 0;
      // Yield ONE representative item so `for (const x of body.items) { ... }`
      // runs its body once and the in-loop assertions/endpoints are captured
      // (not silently dropped). Single item keeps it finite.
      if (prop === Symbol.iterator)
        return function* () {
          yield makeSyntheticResponse();
        };
      if (prop === Symbol.asyncIterator)
        return async function* () {
          yield makeSyntheticResponse();
        };
      if (prop === "status") return 200;
      if (prop === "ok") return true;
      if (prop === "statusText") return "OK";
      if (prop === "length") return 0;
      if (prop === "json" || prop === "text" || prop === "arrayBuffer" || prop === "blob") {
        return () => Promise.resolve(makeSyntheticResponse());
      }
      return makeSyntheticResponse();
    },
    apply() {
      return makeSyntheticResponse();
    },
    has() {
      return true;
    },
  };
  return new Proxy(target, handler);
}

/** A ky-like ResponsePromise: awaitable AND chainable with `.json()`/`.text()`. */
function responsePromise(): any {
  const p: any = Promise.resolve(makeSyntheticResponse());
  p.json = () => Promise.resolve(makeSyntheticResponse());
  p.text = () => Promise.resolve(makeSyntheticResponse());
  p.arrayBuffer = () => Promise.resolve(makeSyntheticResponse());
  return p;
}

/** Builds a recording TestContext plus a collector for what it recorded. */
function makeDryRunCtx() {
  const assertions: ProjAssertion[] = [];
  const endpoints: ProjEndpoint[] = [];
  let reqCount = 0;
  let whenCounter = 0;
  let switchCounter = 0;
  const branchStack: string[] = [];

  const curBranch = (): string | undefined =>
    branchStack.length ? branchStack.join(">") : undefined;

  const record = (method: string, url: unknown) => {
    if (++reqCount > REQUEST_BUDGET) throw new DryRunBudgetExceeded();
    endpoints.push({ method, url: typeof url === "string" ? url : "<dynamic>", branch: curBranch() });
    return responsePromise();
  };

  const pushAssertion = (kind: string, message?: string) => {
    assertions.push({ kind, message, branch: curBranch() });
  };

  // ── http: callable (ky shorthand) + method shortcuts + extend ──
  const http: any = (url: unknown) => record("GET", url);
  http.get = (url: unknown) => record("GET", url);
  http.post = (url: unknown) => record("POST", url);
  http.put = (url: unknown) => record("PUT", url);
  http.patch = (url: unknown) => record("PATCH", url);
  http.delete = (url: unknown) => record("DELETE", url);
  http.head = (url: unknown) => record("HEAD", url);
  http.extend = () => http;

  // ── expect: fluent recorder mirroring the real Expectation surface. ──
  // `.not` is a getter modifier; `.orFail()` is a callable modifier (neither
  // records). Async matchers (`await ctx.expect(res).toHaveJsonBody(...)`) work
  // because `then` is absent — awaiting the chain yields the chain, not a hang.
  const makeExpect = () => {
    const chain: any = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") return undefined; // not thenable → await yields chain
        if (typeof prop === "symbol") return undefined;
        if (prop === "not") return chain; // getter modifier: `.not.toBe(...)`
        if (prop === "orFail") return () => chain; // callable modifier: `.orFail()`
        return (..._args: unknown[]) => {
          // matcher → record one assertion, return chain for further chaining
          pushAssertion(`expect.${String(prop)}`);
          return chain;
        };
      },
      apply() {
        return chain;
      },
    });
    return chain;
  };

  const accessor = {
    get: () => undefined,
    require: () => makeSyntheticResponse(),
    all: () => ({}),
    set: () => {},
    entries: () => [] as [string, unknown][],
  };

  const ctx = {
    vars: accessor,
    secrets: accessor,
    session: accessor,
    http,
    log: () => {},
    warn: () => {},
    assert: (_cond: unknown, message?: string) => pushAssertion("assert", message),
    expect: () => makeExpect(),
    validate: (data: unknown, _schema?: unknown, label?: unknown) => {
      // Schema validation IS a verification — record it so schema-only tests
      // don't project as having zero assertions.
      pushAssertion("validate", typeof label === "string" ? label : undefined);
      return data;
    },
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    skip: (_reason?: string): never => {
      throw new DryRunSkip();
    },
    fail: (message?: string): never => {
      // Record the failure intent but DON'T throw — sibling branch arms must
      // still project. Real ctx.fail throws; dry-run only records the shape.
      pushAssertion("fail", message);
      return undefined as never;
    },
    pollUntil: async (_options: unknown, fn: () => Promise<unknown>) => {
      // Run the predicate once to capture endpoints; ignore its result.
      await fn();
    },
    setTimeout: () => {},
    retryCount: 0,
    getMemoryUsage: () => null,

    // ── projection core: run ALL arms, branch-tagged ──
    when: async (
      _condition: boolean,
      thenFn: () => void | Promise<void>,
      elseFn?: () => void | Promise<void>,
    ): Promise<void> => {
      const idx = whenCounter++;
      branchStack.push(`when#${idx}:then`);
      try {
        await thenFn();
      } finally {
        branchStack.pop();
      }
      if (elseFn) {
        branchStack.push(`when#${idx}:else`);
        try {
          await elseFn();
        } finally {
          branchStack.pop();
        }
      }
    },
    switch: async (cases: SwitchCase[], defaultFn?: () => void | Promise<void>): Promise<void> => {
      const idx = switchCounter++;
      for (let i = 0; i < cases.length; i++) {
        branchStack.push(`switch#${idx}:case[${i}]`);
        try {
          await cases[i].then();
        } finally {
          branchStack.pop();
        }
      }
      if (defaultFn) {
        branchStack.push(`switch#${idx}:default`);
        try {
          await defaultFn();
        } finally {
          branchStack.pop();
        }
      }
    },
  } as unknown as TestContext;

  return { ctx, assertions, endpoints };
}

/**
 * Project one test's shape by executing its body against a synthetic ctx.
 *
 * @param test The Test object (from importing the test module).
 * @param opts.exportName JS export name (for the shape label).
 * @param opts.bareBranchCount Scanner-reported count of native `if`/`switch` in
 *   the body — when > 0 the projection is marked partial.
 */
export async function dryRunTest(
  test: Test,
  opts: { exportName: string; bareBranchCount?: number },
): Promise<TestShape> {
  const testId = test.meta.id;
  const base: Omit<TestShape, "projectionComplete"> = {
    testId,
    exportName: opts.exportName,
    assertions: [],
    endpoints: [],
    assertionCount: 0,
  };

  // Only simple tests have a directly-invokable fn body. Builder/workflow tests
  // express shape through steps (already captured statically by the scanner).
  if (test.type !== "simple" || typeof (test as { fn?: unknown }).fn !== "function") {
    return {
      ...base,
      projectionComplete: false,
      incompleteReason: "not a simple test — dry-run shape projection covers simple tests only",
    };
  }

  const { ctx, assertions, endpoints } = makeDryRunCtx();
  let complete = true;
  let reason: string | undefined;
  let skipped = false;

  try {
    await (test as unknown as { fn: (c: TestContext) => unknown }).fn(ctx);
  } catch (err) {
    if (err instanceof DryRunSkip) {
      skipped = true;
    } else if (err instanceof DryRunBudgetExceeded) {
      complete = false;
      reason = `request budget (${REQUEST_BUDGET}) exceeded — likely a data-dependent loop`;
    } else {
      complete = false;
      reason = `threw during projection: ${(err as Error)?.message ?? String(err)}`;
    }
  }

  // Fold in the static signal: bare branches mean only one arm was followed.
  if (complete && opts.bareBranchCount && opts.bareBranchCount > 0) {
    complete = false;
    reason = `${opts.bareBranchCount} bare if/switch branch(es) — use ctx.when()/ctx.switch() for full projection`;
  }

  return {
    ...base,
    assertions,
    endpoints,
    assertionCount: assertions.length,
    projectionComplete: complete,
    ...(reason ? { incompleteReason: reason } : {}),
    ...(skipped ? { skipped: true } : {}),
  };
}
