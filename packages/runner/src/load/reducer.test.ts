import { describe, expect, it } from "vitest";
import type { LoadEvent, LoadReducer } from "@glubean/sdk/load";
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

describe("createLoadReducer — timelineOrigin (shared distributed axis)", () => {
  it("computes sample, failure and timeline offsets from the injected origin", () => {
    // A worker whose first event lands 5s AFTER the coordinator's shared origin: every
    // offset must be origin-based, not firstTs-based — a late-starting worker's own firstTs
    // would report deceptively small offsets and corrupt the coordinator's first-N ordering.
    const r = createLoadReducer({ timelineOrigin: T0 - 5_000 });
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1, durationMs: 60_000 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "s", iterationId: "i1" }));
    r.apply(ev(T0 + 100, { type: "iteration:end", scenarioId: "s", iterationId: "i1", ok: false, durationMs: 100, errorKind: "http" }));
    const art = r.finalize();
    expect(art.samples.failureTraces[0].completedAtOffsetMs).toBe(5_100); // not 100
    // ALL time metadata sits on the same axis — never two axes in one artifact: startedAt IS
    // the origin, durationMs spans origin → last event (the pre-start idle gap is real run
    // time for a late-starting worker, not a bug), so window offset 5000 + the 100ms of
    // events land inside [0, durationMs].
    expect(art.startedAt).toBe(new Date(T0 - 5_000).toISOString());
    expect(art.durationMs).toBe(5_100);
    // snapshot() shares the axis too (elapsed + throughput denominator), and
    // recentFailures.atMs no longer forks off firstTs.
    const snap = r.snapshot(T0 + 100);
    expect(snap.elapsedMs).toBe(5_100);
    expect(snap.recentFailures[0].atMs).toBe(5_100);
    // Timeline windows: the activity lands in the window covering offset 5100 (250ms base
    // width → offsetMs 5000), after zero-filled idle windows.
    const active = art.timeline?.windows.find((w) => w.iterations === 1);
    expect(active?.offsetMs).toBe(5_000);
    expect(art.timeline?.windows[0]?.offsetMs).toBe(0);
  });

  it("falls back to the first event's ts when absent (single-process, unchanged)", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "s", iterationId: "i1" }));
    r.apply(ev(T0 + 100, { type: "iteration:end", scenarioId: "s", iterationId: "i1", ok: false, durationMs: 100, errorKind: "http" }));
    const art = r.finalize();
    expect(art.samples.failureTraces[0].completedAtOffsetMs).toBe(100);
    expect(art.startedAt).toBe(new Date(T0).toISOString());
    expect(art.durationMs).toBe(100);
  });
});

describe("finalize(runEndMs) — authoritative run interval (distributed D0), via the public LoadReducer contract", () => {
  // Every reducer here is held as the SDK `LoadReducer` interface (createLoadReducer's
  // return type) — proving `runEndMs` is reachable from the public surface, not an
  // impl-only capability (codex R1 P1).
  /** One completed iteration + one request; events span T0 .. T0+2_000 (lastTs = T0+2_000). */
  function feedShard(r: LoadReducer): void {
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1, durationMs: 10_000 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "s", iterationId: "i1" }));
    r.apply(
      ev(T0 + 1_000, {
        type: "request:observed",
        scenarioId: "s",
        stepId: "st",
        method: "GET",
        url: "u",
        routeKey: "GET /x",
        routeKeySource: "explicit",
        routeKeyHeuristic: false,
        status: 200,
        ok: true,
        durationMs: 50,
      }),
    );
    r.apply(ev(T0 + 2_000, { type: "iteration:end", scenarioId: "s", iterationId: "i1", ok: true, durationMs: 2_000 }));
  }

  it("uses a supplied runEnd (> lastTs) as the duration + every throughput denominator", () => {
    // Lost-worker / early-quota shape: the shard stops emitting at T0+2s but the RUN ran to
    // T0+10s (coordinator globalEndAt). An event-extremum denominator (2s) would report
    // 0.5 iter/s — 5× the real 0.1 — because no event lands at the deadline.
    const r: LoadReducer = createLoadReducer({ timelineOrigin: T0 });
    feedShard(r);
    const art = r.finalize(T0 + 10_000);
    expect(art.durationMs).toBe(10_000);
    expect(art.summary.throughputPerSec).toBeCloseTo(0.1, 10); // 1 iteration / 10s
    expect(art.endpoints[0].throughputPerSec).toBeCloseTo(0.1, 10); // 1 request / 10s
    // The timeline zero-fill-extends to the boundary (trailing idle, not truncation):
    // 250ms windows over [0, 10_000) → last window offset 9_750.
    expect(art.timeline?.windows.at(-1)?.offsetMs).toBe(9_750);
  });

  it("falls back to lastTs when absent — single-process status quo (the inflated figure)", () => {
    const r: LoadReducer = createLoadReducer({ timelineOrigin: T0 });
    feedShard(r);
    const art = r.finalize();
    expect(art.durationMs).toBe(2_000);
    expect(art.summary.throughputPerSec).toBeCloseTo(0.5, 10); // the inflation runEnd exists to fix
  });

  it("takes a runEnd < lastTs AT VALUE — coordinator is authoritative, no clamp to lastTs", () => {
    // Trust model (owner 2026-07-14): globalEndAt is the single authority on the run
    // interval; an event past it is clock jitter or a straggler the coordinator already
    // cut. Clamping to lastTs would silently reintroduce the per-worker event-extremum
    // denominator and make merged workers' denominators mutually inconsistent.
    const r: LoadReducer = createLoadReducer({ timelineOrigin: T0 });
    feedShard(r);
    const art = r.finalize(T0 + 1_500);
    expect(art.durationMs).toBe(1_500);
    expect(art.summary.throughputPerSec).toBeCloseTo(1 / 1.5, 10);
  });

  it("floors a runEnd before the origin at an empty interval (no negative duration)", () => {
    const r: LoadReducer = createLoadReducer({ timelineOrigin: T0 });
    feedShard(r);
    const art = r.finalize(T0 - 5_000);
    expect(art.durationMs).toBe(0);
    expect(art.summary.throughputPerSec).toBe(0);
  });

  it("reports the full authoritative window for an idle shard (origin injected, zero events)", () => {
    // A worker that lost its dispatch (or had nothing to do) still describes the REAL run
    // window: duration = globalEndAt − origin, throughput 0 over it — not NaN, not 0ms.
    const r: LoadReducer = createLoadReducer({ timelineOrigin: T0 });
    const art = r.finalize(T0 + 10_000);
    expect(art.startedAt).toBe(new Date(T0).toISOString());
    expect(art.durationMs).toBe(10_000);
    expect(art.summary.throughputPerSec).toBe(0);
    // …and a DENSE all-zero timeline over the interval (reducer-side synthesis — the
    // timeline itself early-returns empty with no recorded window): 250ms windows over
    // [0, 10_000) → 40 windows, offsets 0..9_750, every field zero.
    expect(art.timeline?.windowMs).toBe(250);
    expect(art.timeline?.windows).toHaveLength(40);
    expect(art.timeline?.windows[0]?.offsetMs).toBe(0);
    expect(art.timeline?.windows.at(-1)?.offsetMs).toBe(9_750);
    expect(
      art.timeline?.windows.every(
        (w) =>
          w.requests === 0 && w.errors === 0 && w.iterations === 0 && w.peakInFlight === 0 && w.throughputPerSec === 0,
      ),
    ).toBe(true);
  });

  it("mirrors the timeline's coarsening in the synthetic idle series (long run stays within the cap)", () => {
    const r: LoadReducer = createLoadReducer({ timelineOrigin: T0 });
    // 10 idle minutes: 250ms base → 2400 windows > 600 cap → doubled twice to 1s width.
    const art = r.finalize(T0 + 600_000);
    expect(art.timeline?.windowMs).toBe(1_000);
    expect(art.timeline?.windows).toHaveLength(600);
    expect(art.timeline?.windows.at(-1)?.offsetMs).toBe(599_000);
  });
});

describe("continuation summary — producer release (M6)", () => {
  it("aggregates releases, rejections, duplicates, backpressure, and coverage", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 2, iterations: 3 } }));

    // Three iterations all reach a boundary; i1 + i2 release (i2 back-pressured 30ms),
    // i3's release is rejected (backlog full), plus one duplicate release signal.
    for (const id of ["i1", "i2", "i3"]) {
      r.apply(ev(T0, { type: "iteration:start", scenarioId: "job", iterationId: id }));
      r.apply(ev(T0 + 5, { type: "producer:primaryCompleted", scenarioId: "job", iterationId: id, primaryId: id, primaryDurationMs: 5, releaseRequested: true }));
    }
    r.apply(ev(T0 + 6, { type: "producer:released", scenarioId: "job", iterationId: "i1", releaseId: "i1", primaryDurationMs: 5, continuationBacklog: 1, backpressureMs: 0 }));
    r.apply(ev(T0 + 7, { type: "producer:released", scenarioId: "job", iterationId: "i2", releaseId: "i2", primaryDurationMs: 5, continuationBacklog: 2, continuationBackpressure: true, backpressureMs: 30 }));
    r.apply(ev(T0 + 8, { type: "producer:releaseRejected", scenarioId: "job", iterationId: "i3", releaseId: "i3", reason: "continuationBacklogFull", waitMs: 0, continuationBacklog: 2 }));
    r.apply(ev(T0 + 9, { type: "producer:releaseRejected", scenarioId: "job", iterationId: "i1", releaseId: "i1", reason: "duplicateRelease", waitMs: 0, continuationBacklog: 2 }));

    r.apply(ev(T0 + 100, { type: "iteration:end", scenarioId: "job", iterationId: "i1", ok: true, durationMs: 100 }));
    r.apply(ev(T0 + 110, { type: "iteration:end", scenarioId: "job", iterationId: "i2", ok: true, durationMs: 110 }));
    r.apply(ev(T0 + 120, { type: "iteration:end", scenarioId: "job", iterationId: "i3", ok: false, durationMs: 120, errorKind: "continuationBacklogFull" }));
    r.apply(ev(T0 + 130, { type: "load:end", reason: "iterations" }));

    const art = r.finalize();
    expect(art.runtime.slotModel).toBe("producer-released");
    const c = art.summary.continuation!;
    expect(c.releasedProducerSlots).toBe(2);
    expect(c.rejectedReleaseSignals).toBe(1);
    expect(c.duplicateReleaseSignals).toBe(1);
    expect(c.maxBacklog).toBe(2);
    expect(c.maxConcurrent).toBe(2);
    expect(c.primaryBoundaryCoverage).toBe(1); // 3 boundaries / 3 started
    expect(c.releaseCoverage).toBeCloseTo(2 / 3); // 2 released / 3 boundaries
    expect(c.backpressureMs?.max).toBe(30);
    expect(c.backlog).toBe(0); // drained at finalize
    expect(c.abortedByDrainTimeout).toBe(0);
  });

  it("counts a deadline-rejected release's stall as back-pressure", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1, iterations: 1 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "job", iterationId: "i1" }));
    r.apply(ev(T0 + 5, { type: "producer:primaryCompleted", scenarioId: "job", iterationId: "i1", primaryId: "i1", primaryDurationMs: 5, releaseRequested: true }));
    // Parked on a full backlog until the deadline (stalled 50ms), then rejected.
    r.apply(ev(T0 + 55, { type: "producer:releaseRejected", scenarioId: "job", iterationId: "i1", releaseId: "i1", reason: "runDeadlineReached", waitMs: 50, continuationBacklog: 1 }));
    r.apply(ev(T0 + 100, { type: "iteration:end", scenarioId: "job", iterationId: "i1", ok: true, durationMs: 100 }));
    r.apply(ev(T0 + 110, { type: "load:end", reason: "duration" }));

    const c = r.finalize().summary.continuation!;
    expect(c.rejectedReleaseSignals).toBe(1);
    expect(c.backpressureMs?.max).toBe(50); // the producer stall is recorded, not lost
  });

  it("omits the continuation summary when no release is attempted", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1, iterations: 1 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "s", iterationId: "i1" }));
    r.apply(ev(T0 + 50, { type: "iteration:end", scenarioId: "s", iterationId: "i1", ok: true, durationMs: 50 }));
    r.apply(ev(T0 + 60, { type: "load:end", reason: "iterations" }));
    const art = r.finalize();
    expect(art.summary.continuation).toBeUndefined();
    expect(art.runtime.slotModel).toBe("end-to-end");
  });

  it("tracks LIVE continuations between release and iteration:end (snapshot + interrupted finalize)", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 2, iterations: 2 } }));
    for (const id of ["i1", "i2"]) {
      r.apply(ev(T0, { type: "iteration:start", scenarioId: "job", iterationId: id }));
      r.apply(ev(T0 + 5, { type: "producer:primaryCompleted", scenarioId: "job", iterationId: id, primaryId: id, primaryDurationMs: 5, releaseRequested: true }));
      r.apply(ev(T0 + 6, { type: "producer:released", scenarioId: "job", iterationId: id, releaseId: id, primaryDurationMs: 5, continuationBacklog: 1, backpressureMs: 0 }));
    }
    // Both iterations are in their continuation phase — the live snapshot shows it.
    expect(r.snapshot(T0 + 50).continuationInFlight).toBe(2);

    r.apply(ev(T0 + 100, { type: "iteration:end", scenarioId: "job", iterationId: "i1", ok: true, durationMs: 100 }));
    expect(r.snapshot(T0 + 110).continuationInFlight).toBe(1); // i1 done, i2 still live

    // Interrupted finalize: i2 never ended → its live continuation is reported, not 0.
    const art = r.finalize();
    expect(art.runtime.continuationInFlight).toBe(1);
    expect(art.summary.continuation?.backlog).toBe(1);
    expect(art.summary.continuation?.active).toBe(1);
  });

  it("counts a release parked on a full backlog as blockedOnBacklog until granted", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1, iterations: 1 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "job", iterationId: "i1" }));
    // Boundary hit + release requested, not yet granted → parked on the backlog: it's
    // left primary but isn't a continuation yet.
    r.apply(ev(T0 + 5, { type: "producer:primaryCompleted", scenarioId: "job", iterationId: "i1", primaryId: "i1", primaryDurationMs: 5, releaseRequested: true }));
    let snap = r.snapshot(T0 + 50);
    expect(snap.blockedOnBacklog).toBe(1);
    expect(snap.continuationInFlight).toBe(0);

    r.apply(ev(T0 + 60, { type: "producer:released", scenarioId: "job", iterationId: "i1", releaseId: "i1", primaryDurationMs: 5, continuationBacklog: 1, backpressureMs: 44 }));
    snap = r.snapshot(T0 + 70);
    expect(snap.blockedOnBacklog).toBe(0); // granted
    expect(snap.continuationInFlight).toBe(1); // now a continuation
  });

  it("includes the continuation summary when a release is still parked at finalize", () => {
    const r = createLoadReducer();
    r.apply(ev(T0, { type: "load:start", config: { concurrency: 1, iterations: 1 } }));
    r.apply(ev(T0, { type: "iteration:start", scenarioId: "job", iterationId: "i1" }));
    // Release requested but never granted/rejected — an interrupted finalize while parked.
    r.apply(ev(T0 + 5, { type: "producer:primaryCompleted", scenarioId: "job", iterationId: "i1", primaryId: "i1", primaryDurationMs: 5, releaseRequested: true }));

    const art = r.finalize();
    expect(art.summary.continuation).toBeDefined(); // not omitted despite no released/rejected
    expect(art.runtime.blockedOnBacklog).toBe(1);
    expect(art.summary.continuation?.releasedProducerSlots).toBe(0);
  });
});
