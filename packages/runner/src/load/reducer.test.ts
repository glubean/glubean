import { describe, expect, it } from "vitest";
import type { LoadEvent } from "@glubean/sdk/load";
import { createLoadReducer } from "./reducer.js";

let seq = 0;
function ev(ts: number, extra: Record<string, unknown>): LoadEvent {
  return { ts, seq: seq++, runId: "run1", runnerId: "checkout-300", ...extra } as unknown as LoadEvent;
}

const T0 = 1_000_000;

/** A two-iteration checkout run: i1 succeeds, i2 fails (500 + assertion). */
function feedCheckoutRun() {
  const r = createLoadReducer();
  r.apply(ev(T0, { type: "load:start", config: { concurrency: 10, durationMs: 60_000 } }));

  // iteration 1 — success
  r.apply(ev(T0, { type: "iteration:start", scenarioId: "checkout", iterationId: "i1" }));
  r.apply(ev(T0 + 10, { type: "step:start", scenarioId: "checkout", stepId: "s1", stepName: "login" }));
  r.apply(
    ev(T0 + 50, {
      type: "request:observed",
      scenarioId: "checkout",
      stepId: "s1",
      method: "POST",
      url: "https://x/login",
      routeKey: "POST /login",
      routeKeySource: "normalized-url",
      routeKeyHeuristic: true,
      status: 200,
      ok: true,
      durationMs: 40,
    }),
  );
  r.apply(ev(T0 + 60, { type: "step:end", scenarioId: "checkout", stepId: "s1", stepName: "login", ok: true, durationMs: 50 }));
  r.apply(
    ev(T0 + 100, {
      type: "request:observed",
      scenarioId: "checkout",
      stepId: "s2",
      method: "POST",
      url: "https://x/checkout",
      routeKey: "POST /checkout",
      routeKeySource: "normalized-url",
      routeKeyHeuristic: true,
      status: 201,
      ok: true,
      durationMs: 80,
    }),
  );
  r.apply(ev(T0 + 110, { type: "step:end", scenarioId: "checkout", stepId: "s2", stepName: "checkout", ok: true, durationMs: 90 }));
  r.apply(ev(T0 + 200, { type: "iteration:end", scenarioId: "checkout", iterationId: "i1", ok: true, durationMs: 200 }));

  // iteration 2 — failure (500 + assertion)
  r.apply(ev(T0 + 200, { type: "iteration:start", scenarioId: "checkout", iterationId: "i2" }));
  r.apply(
    ev(T0 + 260, {
      type: "request:observed",
      scenarioId: "checkout",
      stepId: "s2",
      method: "POST",
      url: "https://x/checkout",
      routeKey: "POST /checkout",
      routeKeySource: "normalized-url",
      routeKeyHeuristic: true,
      status: 500,
      ok: false,
      durationMs: 120,
      errorKind: "http",
    }),
  );
  r.apply(
    ev(T0 + 270, {
      type: "step:end",
      scenarioId: "checkout",
      stepId: "s2",
      stepName: "checkout",
      ok: false,
      durationMs: 130,
      assertionFailures: 1,
      errorKind: "http",
    }),
  );
  r.apply(ev(T0 + 350, { type: "iteration:end", scenarioId: "checkout", iterationId: "i2", ok: false, durationMs: 150, errorKind: "http" }));

  r.apply(ev(T0 + 60_000, { type: "load:end", reason: "duration" }));
  return r;
}

describe("LoadReducer.finalize", () => {
  it("assembles a glubean.load.v1 artifact from the event stream", () => {
    const art = feedCheckoutRun().finalize();

    expect(art.schemaVersion).toBe("glubean.load.v1");
    expect(art.runnerId).toBe("checkout-300");
    expect(art.runMode).toBe("load");
    expect(art.startedAt).toBe(new Date(T0).toISOString());
    expect(art.durationMs).toBe(60_000);
    expect(art.runtime.percentileSource).toBe("glubean-reducer");
    expect(art.runtime.feederGuarantee).toBe("single-node");
    // any heuristic endpoint downgrades endpoint attribution
    expect(art.runtime.attribution.endpoint).toBe("heuristic");
    expect(art.runtime.attribution.scenario).toBe("canonical");
  });

  it("computes transaction summary (2 iterations, 1 failed)", () => {
    const s = feedCheckoutRun().finalize().summary;
    expect(s.totalIterations).toBe(2);
    expect(s.successfulIterations).toBe(1);
    expect(s.failedIterations).toBe(1);
    expect(s.errorRate).toBe(0.5);
    expect(s.pass).toBe(true); // ended by duration, no crash
    expect(s.thresholds).toEqual([]);
    expect(s.latency.max).toBe(200);
  });

  it("aggregates per-scenario and per-step", () => {
    const art = feedCheckoutRun().finalize();
    expect(art.scenarios).toHaveLength(1);
    const sc = art.scenarios[0];
    expect(sc.scenarioId).toBe("checkout");
    expect(sc.iterations).toBe(2);
    expect(sc.failedIterations).toBe(1);

    const checkoutStep = art.steps.find((s) => s.stepName === "checkout");
    expect(checkoutStep?.invocationCount).toBe(2);
    expect(checkoutStep?.errorCount).toBe(1);
    expect(checkoutStep?.assertionFailureCount).toBe(1);
    expect(checkoutStep?.requestCount).toBe(2);
    const loginStep = art.steps.find((s) => s.stepName === "login");
    expect(loginStep?.requestCount).toBe(1);
    expect(loginStep?.errorCount).toBe(0);
  });

  it("aggregates per-endpoint with status counts and error rate", () => {
    const art = feedCheckoutRun().finalize();
    const checkout = art.endpoints.find((e) => e.routeKey === "POST /checkout");
    expect(checkout?.requestCount).toBe(2);
    expect(checkout?.errorCount).toBe(1);
    expect(checkout?.errorRate).toBe(0.5);
    expect(checkout?.statusCounts).toEqual({ "201": 1, "500": 1 });
    expect(checkout?.routeKeyHeuristic).toBe(true);
    const login = art.endpoints.find((e) => e.routeKey === "POST /login");
    expect(login?.requestCount).toBe(1);
    expect(login?.throughputPerSec).toBeCloseTo(1 / 60, 5);
  });

  it("builds the scenario-step × endpoint matrix", () => {
    const art = feedCheckoutRun().finalize();
    const cell = art.matrix.find((m) => m.stepId === "s2" && m.routeKey === "POST /checkout");
    expect(cell?.requestCount).toBe(2);
    expect(cell?.errorRate).toBe(0.5);
    expect(cell?.scenarioId).toBe("checkout");
    expect(cell?.stepName).toBe("checkout"); // resolved from step:end even though request arrived first
  });
});

describe("LoadReducer.snapshot", () => {
  it("reflects in-flight and completed iterations mid-run", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 10 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "c", iterationId: "i1" }));
    r.apply(ev(T0 + 100, { type: "iteration:end", scenarioId: "c", iterationId: "i1", ok: true, durationMs: 100 }));
    r.apply(ev(T0 + 100, { type: "iteration:start", scenarioId: "c", iterationId: "i2" }));

    const snap = r.snapshot(T0 + 200);
    expect(snap.requestedConcurrency).toBe(10);
    expect(snap.primaryStarted).toBe(2);
    expect(snap.primaryCompleted).toBe(1);
    expect(snap.primaryInFlight).toBe(1);
    expect(snap.elapsedMs).toBe(200);
    expect(snap.throughputPerSec).toBeCloseTo(1 / 0.2, 5);
  });
});

describe("LoadReducer crash", () => {
  it("marks pass=false and records the crash on a run-fatal load:end", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 5 } }));
    r.apply(
      ev(T0 + 10, {
        type: "load:end",
        reason: "crash",
        crash: { kind: "unhandledRejection", message: "boom", atMs: 10 },
      }),
    );
    const art = r.finalize();
    expect(art.summary.pass).toBe(false);
    expect(art.runtime.crash?.kind).toBe("unhandledRejection");
    expect(art.runtime.crash?.message).toBe("boom");
  });
});

describe("LoadReducer — traffic mix (scenarioRefId) + groups", () => {
  it("keeps step + matrix aggregates separate per scenarioRefId and captures groupId", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 4 } }));
    for (const ref of ["a", "b"]) {
      r.apply(ev(T0, { type: "iteration:start", scenarioId: "checkout", scenarioRefId: ref, iterationId: `${ref}1` }));
      r.apply(ev(T0 + 5, { type: "step:start", scenarioId: "checkout", scenarioRefId: ref, stepId: "s1", stepName: "buy", groupId: "g1" }));
      r.apply(
        ev(T0 + 10, {
          type: "request:observed",
          scenarioId: "checkout",
          scenarioRefId: ref,
          stepId: "s1",
          method: "POST",
          url: "u",
          routeKey: "POST /buy",
          routeKeySource: "normalized-url",
          routeKeyHeuristic: true,
          status: 200,
          ok: true,
          durationMs: 10,
        }),
      );
      r.apply(ev(T0 + 20, { type: "step:end", scenarioId: "checkout", scenarioRefId: ref, stepId: "s1", stepName: "buy", ok: true, durationMs: 20 }));
      r.apply(ev(T0 + 30, { type: "iteration:end", scenarioId: "checkout", scenarioRefId: ref, iterationId: `${ref}1`, ok: true, durationMs: 30 }));
    }
    r.apply(ev(T0 + 1000, { type: "load:end", reason: "duration" }));
    const art = r.finalize();

    expect(art.scenarios).toHaveLength(2);
    for (const ref of ["a", "b"]) {
      const sc = art.scenarios.find((s) => s.scenarioRefId === ref);
      expect(sc?.iterations).toBe(1);
      expect(sc?.steps).toHaveLength(1);
      expect(sc?.steps[0].invocationCount).toBe(1); // NOT merged across refs
      expect(sc?.steps[0].groupId).toBe("g1"); // captured from step:start
      expect(sc?.steps[0].requestCount).toBe(1);
    }
    expect(art.matrix.filter((m) => m.scenarioRefId === "a")).toHaveLength(1);
    expect(art.matrix.filter((m) => m.scenarioRefId === "b")).toHaveLength(1);
    expect(art.matrix.find((m) => m.scenarioRefId === "a")?.requestCount).toBe(1);
  });

  it("snapshot reports non-zero endpoint throughput mid-run", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 2 } }));
    r.apply(
      ev(T0 + 10, {
        type: "request:observed",
        scenarioId: "c",
        stepId: "s",
        method: "GET",
        url: "u",
        routeKey: "GET /x",
        routeKeySource: "normalized-url",
        routeKeyHeuristic: true,
        status: 200,
        ok: true,
        durationMs: 5,
      }),
    );
    const snap = r.snapshot(T0 + 1000); // 1s elapsed
    expect(snap.topSlowEndpoints).toHaveLength(1);
    expect(snap.topSlowEndpoints[0].throughputPerSec).toBeCloseTo(1, 5);
  });
});

describe("LoadReducer — interrupted runs + attribution quality", () => {
  it("preserves in-flight count and scenario attribution for an interrupted (abort) run", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 3 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "c", iterationId: "i1" }));
    r.apply(ev(T0 + 5, { type: "iteration:start", scenarioId: "c", iterationId: "i2" }));
    r.apply(ev(T0 + 6, { type: "iteration:start", scenarioId: "d", iterationId: "d1" })); // never ends
    r.apply(ev(T0 + 50, { type: "iteration:end", scenarioId: "c", iterationId: "i1", ok: true, durationMs: 50 }));
    r.apply(ev(T0 + 100, { type: "load:end", reason: "abort" }));
    const art = r.finalize();
    expect(art.runtime.primaryInFlight).toBe(2); // i2 + d1 in flight (3 started, 1 completed)
    // scenario "d" was seeded at iteration:start even though it never completed
    expect(art.scenarios.map((s) => s.scenarioId).sort()).toEqual(["c", "d"]);
    expect(art.scenarios.find((s) => s.scenarioId === "d")?.iterations).toBe(0);
  });

  it("promotes endpoint attribution to heuristic if any request is heuristic (order-independent)", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 2 } }));
    const req = (ts: number, source: "explicit" | "normalized-url", heuristic: boolean) =>
      ev(ts, {
        type: "request:observed",
        scenarioId: "c",
        stepId: "s",
        method: "GET",
        url: "u",
        routeKey: "GET /x",
        routeKeySource: source,
        routeKeyHeuristic: heuristic,
        status: 200,
        ok: true,
        durationMs: 5,
      });
    r.apply(req(T0 + 1, "explicit", false)); // first: canonical
    r.apply(req(T0 + 2, "normalized-url", true)); // later: heuristic
    r.apply(ev(T0 + 1000, { type: "load:end", reason: "duration" }));
    const art = r.finalize();
    expect(art.endpoints.find((e) => e.routeKey === "GET /x")?.routeKeyHeuristic).toBe(true);
    expect(art.runtime.attribution.endpoint).toBe("heuristic");
  });
});
