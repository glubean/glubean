import { describe, expect, it } from "vitest";

import type { LoadArtifact, LoadEvent, LoadProgressSnapshot, LoadReducer } from "@glubean/sdk/load";
import { LoadSink } from "./sink.js";

/** A reducer that captures every event forwarded to it (for asserting emitted shapes). */
function capturingReducer(): LoadReducer & { events: LoadEvent[] } {
  const events: LoadEvent[] = [];
  return {
    events,
    apply(e) { events.push(e); },
    snapshot: () => ({}) as unknown as LoadProgressSnapshot,
    finalize: () => ({}) as unknown as LoadArtifact,
  };
}

/** A reducer that just counts the events forwarded to it. */
function countingReducer(): LoadReducer & { applied: number } {
  return {
    applied: 0,
    apply() { this.applied += 1; },
    snapshot: () => ({}) as unknown as LoadProgressSnapshot,
    finalize: () => ({}) as unknown as LoadArtifact,
  };
}

describe("LoadSink — seal (M6)", () => {
  it("stops forwarding events to the reducer once sealed", () => {
    const reducer = countingReducer();
    const sink = new LoadSink(reducer, "run", "runner", () => 0);

    sink.emitLoadStart({ concurrency: 1 });
    sink.emitProducerSlotStart(0);
    expect(reducer.applied).toBe(2);

    // After the run is finalized, an abandoned continuation's late events are dropped.
    sink.seal();
    sink.emitProducerSlotEnd(0, 0);
    sink.beginIteration({ scenarioId: "s", producerSlotId: "p0", iterationId: "late" });
    sink.emitIterationEnd({ scenarioId: "s", producerSlotId: "p0", iterationId: "late" }, { ok: true, durationMs: 1 });
    sink.handleWire({ testId: "late", type: "step_end", index: 0, name: "x", status: "passed", durationMs: 1 });

    expect(reducer.applied).toBe(2); // unchanged — nothing forwarded after seal
  });

  it("drops a metric:observed from a handle that fires after its iteration ended", () => {
    const reducer = capturingReducer();
    const sink = new LoadSink(reducer, "run", "runner", () => 0);
    const env = { scenarioId: "s", producerSlotId: "p0", iterationId: "it-1" };

    sink.beginIteration(env);
    sink.emitMetricObserved(env, { metricId: "pollOk", kind: "rate", value: 1 });
    sink.emitIterationEnd(env, { ok: true, durationMs: 1 });
    sink.endIteration("it-1");
    // The handle escaped the step and fires late (iteration unregistered, run not sealed):
    sink.emitMetricObserved(env, { metricId: "pollOk", kind: "rate", value: 0 });

    const metricEvents = reducer.events.filter((e) => e.type === "metric:observed");
    expect(metricEvents).toHaveLength(1); // only the in-iteration one survived
    expect((metricEvents[0] as { value: number }).value).toBe(1);
  });
});

describe("LoadSink — tailPollExecuted (M6-d)", () => {
  const reqTrace = (iterationId: string, stepIndex: number) => ({
    testId: iterationId,
    type: "trace",
    stepIndex,
    data: { method: "POST", url: "http://x/orders", ok: true, durationMs: 1 },
  });
  const pollEvent = (iterationId: string, index: number) => ({
    testId: iterationId, type: "poll", index, name: "p", attempts: 1, satisfied: true,
  });
  const env = (iterationId: string) => ({ scenarioId: "s", producerSlotId: "p0", iterationId });

  it("flags an unreleased TAIL poll — a request before it (earlier step) and none after", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0)); // step 0 (submit) issued the primary request
    sink.handleWire(pollEvent("it", 1)); // poll is step 1, nothing after it
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(true);
  });

  it("does NOT flag a tail poll whose iteration requested release BEFORE the poll", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0));
    sink.emitPrimaryCompleted(env("it"), { primaryId: "p", primaryDurationMs: 1, releaseRequested: true });
    sink.handleWire(pollEvent("it", 1)); // poll runs AFTER release → slot was freed for it
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(false);
  });

  it("DOES flag a tail poll whose release was requested only AFTER the poll (misordered)", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0));
    sink.handleWire(pollEvent("it", 1)); // poll runs FIRST — the slot was held for it
    sink.emitPrimaryCompleted(env("it"), { primaryId: "p", primaryDurationMs: 1, releaseRequested: true });
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(true); // a late release can't free the slot in hindsight
  });

  it("flags a held poll at RELEASE time (survives a drain-abandoned continuation, no endIteration)", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0));
    sink.handleWire(pollEvent("it", 1)); // poll held the slot
    sink.emitPrimaryCompleted(env("it"), { primaryId: "p", primaryDurationMs: 1, releaseRequested: true });
    // No endIteration() — the continuation is abandoned by the drain timeout. Still flagged.
    expect(sink.unreleasedTailPollRan).toBe(true);
  });

  it("flags an earlier held poll even when a later poll runs after release", () => {
    // submit → poll1 (slot held) → release → poll2 (freed, even with its own request). The
    // later released poll2 must NOT erase poll1's held status.
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0)); // submit, step 0
    sink.handleWire(pollEvent("it", 1)); // poll1 — held the slot (before release)
    sink.emitPrimaryCompleted(env("it"), { primaryId: "p", primaryDurationMs: 1, releaseRequested: true });
    sink.handleWire(reqTrace("it", 3)); // poll2's own attempt request, step 3
    sink.handleWire(pollEvent("it", 3)); // poll2 — ran on the freed slot
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(true); // poll1 still held the slot
  });

  it("does NOT flag a readiness poll that only made its OWN requests (same step index)", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0)); // the poll's own attempt request, step 0
    sink.handleWire(pollEvent("it", 0)); // poll is step 0 — no EARLIER step request
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(false);
  });

  it("does NOT flag a readiness poll followed by a later load request (setup → poll → submit)", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0)); // setup/auth request, step 0
    sink.handleWire(pollEvent("it", 1)); // readiness poll, step 1
    sink.handleWire(reqTrace("it", 2)); // the PRIMARY load, step 2 — AFTER the poll
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(false); // a request followed the poll → not a tail
  });

  it("flags a held poll after a BARE primaryComplete even if a continuation request follows", () => {
    // submit(0) → bare primaryComplete (boundary, no release) → poll(1, held) → req(2). The
    // post-boundary request is continuation and must not disqualify the held poll.
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0)); // submit, step 0
    sink.emitPrimaryCompleted(env("it"), { primaryId: "p", primaryDurationMs: 1, releaseRequested: false }); // BARE
    sink.handleWire(pollEvent("it", 1)); // poll held the slot (no release)
    sink.handleWire(reqTrace("it", 2)); // continuation request, step 2 — post-boundary
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(true);
  });

  it("does NOT flag a readiness poll when release follows the actual load request", () => {
    // setup-req(0) → readiness poll(1) → real load(2) → release(3). The poll is pre-primary
    // (a primary-phase load request follows it), and release came correctly after the load.
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire(reqTrace("it", 0)); // setup/auth request, step 0
    sink.handleWire(pollEvent("it", 1)); // readiness poll, step 1
    sink.handleWire(reqTrace("it", 2)); // the real load, step 2 — a PRIMARY-phase request after the poll
    sink.emitPrimaryCompleted(env("it"), { primaryId: "p", primaryDurationMs: 1, releaseRequested: true });
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(false); // primary request after the poll → not a tail
  });

  it("does NOT treat an unscoped setup request (no stepIndex) as a primary request", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire({ testId: "it", type: "trace", data: { method: "GET", url: "http://x/auth", ok: true, durationMs: 1 } });
    sink.handleWire(pollEvent("it", 0)); // a pre-primary readiness poll at step 0
    sink.handleWire(reqTrace("it", 1)); // the real load at step 1, AFTER the poll
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(false); // setup trace must not establish the span
  });

  it("stays false when no poll runs (only normal steps)", () => {
    const sink = new LoadSink(countingReducer(), "run", "runner", () => 0);
    sink.beginIteration(env("it"));
    sink.handleWire({ testId: "it", type: "step_end", index: 0, name: "submit", status: "passed", durationMs: 1 });
    sink.endIteration("it");
    expect(sink.unreleasedTailPollRan).toBe(false);
  });
});

describe("LoadSink — exact routeKey from a trace (M8)", () => {
  const requestOf = (reducer: ReturnType<typeof capturingReducer>) =>
    reducer.events.find((e) => e.type === "request:observed") as Extract<LoadEvent, { type: "request:observed" }>;

  it("uses the trace's exact route template (contract-metadata, not heuristic)", () => {
    const reducer = capturingReducer();
    const sink = new LoadSink(reducer, "run", "runner", () => 0);
    sink.beginIteration({ scenarioId: "s", producerSlotId: "p0", iterationId: "it" });
    sink.handleWire({
      testId: "it", type: "trace", stepIndex: 0,
      data: { method: "GET", url: "http://h/runs/run-abc", target: "GET /runs/run-abc", routeKey: "GET /runs/:runId", status: 200, ok: true, durationMs: 5 },
    });
    const req = requestOf(reducer);
    expect(req.routeKey).toBe("GET /runs/:runId");
    expect(req.routeKeySource).toBe("contract-metadata");
    expect(req.routeKeyHeuristic).toBe(false);
  });

  it("falls back to heuristic URL normalization when the trace has no route template", () => {
    const reducer = capturingReducer();
    const sink = new LoadSink(reducer, "run", "runner", () => 0);
    sink.beginIteration({ scenarioId: "s", producerSlotId: "p0", iterationId: "it" });
    sink.handleWire({
      testId: "it", type: "trace", stepIndex: 0,
      data: { method: "GET", url: "http://h/items/42", target: "GET /items/42", status: 200, ok: true, durationMs: 5 },
    });
    const req = requestOf(reducer);
    expect(req.routeKey).toBe("GET /items/:id");
    expect(req.routeKeySource).toBe("normalized-url");
    expect(req.routeKeyHeuristic).toBe(true);
  });
});
