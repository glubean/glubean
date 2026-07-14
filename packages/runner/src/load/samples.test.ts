import { describe, it, expect } from "vitest";

import type { LoadSlowTransactionSummary } from "@glubean/sdk/load";

import { compareSlow, LoadSampleCollector } from "./samples.js";

describe("LoadSampleCollector", () => {
  it("keeps a failure trace with its observations and the failed step", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it-1", { scenarioId: "checkout", producerSlotId: "p0" });
    c.recordRequest("it-1", { tsOffsetMs: 10, stepId: "1:submit", method: "POST", routeKey: "POST /checkout", status: 500, ok: false, durationMs: 120, errorKind: "http" });
    c.recordStep("it-1", { stepId: "1:submit", stepName: "submit", durationMs: 130, ok: false, skipped: false });
    c.endIteration("it-1", { ok: false, durationMs: 130, errorKind: "http" });
    const s = c.finalize();
    expect(s.failureTraces).toHaveLength(1);
    const f = s.failureTraces[0];
    expect(f.identity).toMatchObject({ scenarioId: "checkout", iterationId: "it-1", producerSlotId: "p0" });
    expect(f.errorKind).toBe("http");
    expect(f.failedStepName).toBe("submit");
    expect(f.observations).toHaveLength(1);
    expect(f.observations[0]).toMatchObject({ type: "request", routeKey: "POST /checkout", status: 500, ok: false });
    expect(s.slowTransactions).toHaveLength(0);
  });

  it("keeps the top-N slowest SUCCESSFUL transactions, sorted descending", () => {
    const c = new LoadSampleCollector();
    for (const [id, dur] of [["a", 100], ["b", 300], ["c", 200]] as const) {
      c.beginIteration(id, { scenarioId: "s", producerSlotId: "p0" });
      c.recordStep(id, { stepId: "1:x", stepName: "x", durationMs: dur, ok: true, skipped: false });
      c.endIteration(id, { ok: true, durationMs: dur });
    }
    const s = c.finalize();
    expect(s.slowTransactions.map((t) => t.durationMs)).toEqual([300, 200, 100]);
    expect(s.slowTransactions[0].identity.iterationId).toBe("b");
    expect(s.slowTransactions[0].slowStepName).toBe("x");
    expect(s.failureTraces).toHaveLength(0);
  });

  it("caps failure traces at the max (keeps the first N to complete)", () => {
    const c = new LoadSampleCollector();
    for (let i = 0; i < 25; i++) {
      c.beginIteration(`f${i}`, { scenarioId: "s", producerSlotId: "p0" });
      c.endIteration(`f${i}`, { ok: false, durationMs: 10, errorKind: "assertion", completedAtOffsetMs: i * 10 });
    }
    const s = c.finalize();
    expect(s.failureTraces).toHaveLength(20);
    expect(s.maxFailureTraces).toBe(20);
    // The EARLIEST 20 completions are the kept set (the onset is the useful part).
    expect(s.failureTraces[0].identity.iterationId).toBe("f0");
    expect(s.failureTraces[19].identity.iterationId).toBe("f19");
  });

  it("caps observations per trace and records the dropped count", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    for (let i = 0; i < 50; i++) {
      c.recordRequest("it", { tsOffsetMs: i, method: "GET", routeKey: "GET /x", ok: false, durationMs: 5 });
    }
    c.endIteration("it", { ok: false, durationMs: 100, errorKind: "http" });
    const f = c.finalize().failureTraces[0];
    expect(f.observations).toHaveLength(40);
    expect(f.truncated).toBe(true);
    expect(f.droppedObservationCount).toBe(10);
  });

  it("computes a slow transaction's top endpoints by duration", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordRequest("it", { tsOffsetMs: 0, method: "GET", routeKey: "GET /a", ok: true, durationMs: 50 });
    c.recordRequest("it", { tsOffsetMs: 1, method: "POST", routeKey: "POST /b", ok: true, durationMs: 200 });
    c.recordRequest("it", { tsOffsetMs: 2, method: "GET", routeKey: "GET /c", ok: true, durationMs: 90 });
    c.recordRequest("it", { tsOffsetMs: 3, method: "GET", routeKey: "GET /d", ok: true, durationMs: 10 });
    c.endIteration("it", { ok: true, durationMs: 350 });
    const t = c.finalize().slowTransactions[0];
    expect(t.topEndpoints.map((e) => e.routeKey)).toEqual(["POST /b", "GET /c", "GET /a"]); // top 3
  });

  it("honors configured caps — 0 disables a sample type, and the slow cap bounds the top-N", () => {
    const c = new LoadSampleCollector({ maxFailureTraces: 0, maxSlowTransactionSummaries: 2 });
    c.beginIteration("f", { scenarioId: "s", producerSlotId: "p0" });
    c.recordRequest("f", { tsOffsetMs: 0, method: "GET", routeKey: "GET /x", ok: false, durationMs: 5 });
    c.endIteration("f", { ok: false, durationMs: 5, errorKind: "http" });
    for (const [id, dur] of [["a", 10], ["b", 20], ["c", 30]] as const) {
      c.beginIteration(id, { scenarioId: "s", producerSlotId: "p0" });
      c.endIteration(id, { ok: true, durationMs: dur });
    }
    const s = c.finalize();
    expect(s.maxFailureTraces).toBe(0);
    expect(s.failureTraces).toHaveLength(0); // disabled — nothing buffered or kept
    expect(s.maxSlowTransactionSummaries).toBe(2);
    expect(s.slowTransactions.map((t) => t.durationMs)).toEqual([30, 20]); // top 2 only
  });

  it("captures a failed assertion's message + actual/expected values in the trace", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordAssertionFailure("it", { tsOffsetMs: 5, stepId: "1:check", message: "order accepted", actual: 409, expected: 201 });
    c.endIteration("it", { ok: false, durationMs: 40, errorKind: "assertion" });
    const f = c.finalize().failureTraces[0];
    expect(f.observations[0]).toMatchObject({
      type: "assertion",
      passed: false,
      message: "order accepted",
      actualPreview: 409,
      expectedPreview: 201,
    });
  });

  it("truncates a long assertion value preview", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordAssertionFailure("it", { tsOffsetMs: 0, actual: "x".repeat(1000) });
    c.endIteration("it", { ok: false, durationMs: 1, errorKind: "assertion" });
    const obs = c.finalize().failureTraces[0].observations[0] as { actualPreview: string };
    expect(obs.actualPreview.length).toBeLessThanOrEqual(513); // 512 chars + the ellipsis
    expect(obs.actualPreview.endsWith("…")).toBe(true);
  });

  it("bounds a large structured assertion value to a capped preview string", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: "x".repeat(50) })) };
    c.recordAssertionFailure("it", { tsOffsetMs: 0, expected: big });
    c.endIteration("it", { ok: false, durationMs: 1, errorKind: "assertion" });
    const obs = c.finalize().failureTraces[0].observations[0] as { expectedPreview: unknown };
    expect(typeof obs.expectedPreview).toBe("string"); // serialized, not the live object
    expect((obs.expectedPreview as string).length).toBeLessThanOrEqual(513);
  });

  it("renders BigInt assertion previews JSON-safe (the artifact is later stringified)", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordAssertionFailure("it", { tsOffsetMs: 0, actual: 42n, expected: { id: 7n } });
    c.endIteration("it", { ok: false, durationMs: 1, errorKind: "assertion" });
    const s = c.finalize();
    expect(() => JSON.stringify(s)).not.toThrow(); // a raw BigInt would throw here
    const obs = s.failureTraces[0].observations[0] as { actualPreview: unknown; expectedPreview: unknown };
    expect(obs.actualPreview).toBe("42n");
    expect(obs.expectedPreview).toBe('{"id":"7n"}'); // nested BigInt handled in the replacer
  });

  it("keeps the failing assertion even when requests fill the observation buffer", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    for (let i = 0; i < 45; i++) {
      c.recordRequest("it", { tsOffsetMs: i, method: "GET", routeKey: "GET /poll", ok: true, durationMs: 5 });
    }
    c.recordAssertionFailure("it", { tsOffsetMs: 99, message: "boom", expected: 201, actual: 500 });
    c.endIteration("it", { ok: false, durationMs: 100, errorKind: "assertion" });
    const f = c.finalize().failureTraces[0];
    expect(f.observations).toHaveLength(40); // still capped
    const assertionObs = f.observations.filter((o) => o.type === "assertion");
    expect(assertionObs).toHaveLength(1); // the failure cause survived the request flood
    expect(assertionObs[0]).toMatchObject({ message: "boom", expectedPreview: 201, actualPreview: 500 });
  });

  it("keeps a failed request even when successful requests fill the buffer", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    for (let i = 0; i < 45; i++) {
      c.recordRequest("it", { tsOffsetMs: i, method: "GET", routeKey: "GET /poll", ok: true, durationMs: 5 });
    }
    c.recordRequest("it", { tsOffsetMs: 99, method: "POST", routeKey: "POST /checkout", status: 500, ok: false, durationMs: 80, errorKind: "http" });
    c.endIteration("it", { ok: false, durationMs: 100, errorKind: "http" });
    const f = c.finalize().failureTraces[0];
    expect(f.observations).toHaveLength(40); // still capped
    const failed = f.observations.filter((o) => o.type === "request" && !(o as { ok: boolean }).ok);
    expect(failed).toHaveLength(1); // the 500 survived the flood of successful polls
    expect(failed[0]).toMatchObject({ routeKey: "POST /checkout", status: 500 });
  });

  it("caps concurrently-buffered iterations as a memory backstop", () => {
    const c = new LoadSampleCollector({ maxFailureTraces: 100_000 }); // don't let the trace cap mask the buffer cap
    const N = 4096 + 5; // MAX_ACTIVE_BUFFERS + a few
    for (let i = 0; i < N; i++) c.beginIteration(`it-${i}`, { scenarioId: "s", producerSlotId: "p0" });
    for (let i = 0; i < N; i++) c.endIteration(`it-${i}`, { ok: false, durationMs: 1, errorKind: "http" });
    // Only the first MAX_ACTIVE_BUFFERS iterations got a buffer, so only they yield a trace.
    expect(c.finalize().failureTraces).toHaveLength(4096);
  });

  it("length-caps a Symbol / function preview", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordAssertionFailure("it", { tsOffsetMs: 0, actual: Symbol("d".repeat(2000)) });
    c.endIteration("it", { ok: false, durationMs: 1, errorKind: "assertion" });
    const obs = c.finalize().failureTraces[0].observations[0] as { actualPreview: string };
    expect(obs.actualPreview.length).toBeLessThanOrEqual(513); // not the full 2000-char description
  });

  it("renders non-finite number previews JSON-safe (NaN / Infinity → strings)", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordAssertionFailure("it", { tsOffsetMs: 0, actual: Number.NaN, expected: Number.POSITIVE_INFINITY });
    c.endIteration("it", { ok: false, durationMs: 1, errorKind: "assertion" });
    const obs = c.finalize().failureTraces[0].observations[0] as { actualPreview: unknown; expectedPreview: unknown };
    expect(obs.actualPreview).toBe("NaN"); // JSON would turn the raw number into null
    expect(obs.expectedPreview).toBe("Infinity");
  });

  it("threads feeder key attribution into the sample identity", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it-7", { scenarioId: "s", producerSlotId: "p0", feederKeys: { users: "alice", region: "us-east" } });
    c.recordStep("it-7", { stepId: "1:x", stepName: "x", durationMs: 50, ok: true, skipped: false });
    c.endIteration("it-7", { ok: true, durationMs: 50 });
    const t = c.finalize().slowTransactions[0];
    expect(t.identity.feeders).toEqual({ users: { key: "alice" }, region: { key: "us-east" } });
  });

  it("threads completedAtOffsetMs onto failure and slow samples (and omits it when absent)", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("f1", { scenarioId: "s", producerSlotId: "p0" });
    c.endIteration("f1", { ok: false, durationMs: 10, errorKind: "http", completedAtOffsetMs: 150 });
    c.beginIteration("s1", { scenarioId: "s", producerSlotId: "p0" });
    c.endIteration("s1", { ok: true, durationMs: 20, completedAtOffsetMs: 275 });
    c.beginIteration("s2", { scenarioId: "s", producerSlotId: "p0" });
    c.endIteration("s2", { ok: true, durationMs: 30 }); // caller without the field (older event path)
    const s = c.finalize();
    expect(s.failureTraces[0].completedAtOffsetMs).toBe(150);
    const byId = Object.fromEntries(s.slowTransactions.map((t) => [t.identity.iterationId, t]));
    expect(byId.s1.completedAtOffsetMs).toBe(275);
    expect("completedAtOffsetMs" in byId.s2).toBe(false); // omitted, not undefined — the artifact is JSON
  });

  it("evicts deterministically on equal durations — total order, not arrival order", () => {
    // Ties break on (workerId asc, iterationId asc) — with the cap at 2 the largest
    // iterationId among the three equal-duration transactions is out, whatever order
    // they arrive in. (Pre-D0 the incumbent always won a tie, so retention depended
    // on arrival order and a distributed merge could not reproduce it.)
    for (const arrival of [
      ["it-b", "it-a", "it-c"],
      ["it-c", "it-b", "it-a"],
      ["it-a", "it-c", "it-b"],
    ]) {
      const c = new LoadSampleCollector({ maxSlowTransactionSummaries: 2 });
      for (const id of arrival) {
        c.beginIteration(id, { scenarioId: "s", producerSlotId: "p0" });
        c.endIteration(id, { ok: true, durationMs: 100 });
      }
      expect(c.finalize().slowTransactions.map((t) => t.identity.iterationId)).toEqual(["it-a", "it-b"]);
    }
  });

  it("stamps a configured workerId into both sample identities (absent by default)", () => {
    const c = new LoadSampleCollector({ workerId: "w3" });
    c.beginIteration("it-f", { scenarioId: "s", producerSlotId: "p0" });
    c.endIteration("it-f", { ok: false, durationMs: 10, errorKind: "http", completedAtOffsetMs: 5 });
    c.beginIteration("it-s", { scenarioId: "s", producerSlotId: "p0" });
    c.endIteration("it-s", { ok: true, durationMs: 20, completedAtOffsetMs: 25 });
    const s = c.finalize();
    expect(s.failureTraces[0].identity.workerId).toBe("w3");
    expect(s.slowTransactions[0].identity.workerId).toBe("w3");
    // Single-process default: the key is OMITTED (not undefined) — the artifact is JSON.
    const single = new LoadSampleCollector();
    single.beginIteration("it-1", { scenarioId: "s", producerSlotId: "p0" });
    single.endIteration("it-1", { ok: true, durationMs: 20 });
    expect("workerId" in single.finalize().slowTransactions[0].identity).toBe(false);
  });

  it("compareSlow breaks equal-duration ties by workerId then iterationId (the merge order)", () => {
    // The comparator is exported so the coordinator merge sorts by the SAME order the
    // collectors retained under — exercise the cross-worker keys a single collector can't.
    const s = (workerId: string | undefined, iterationId: string, durationMs: number): LoadSlowTransactionSummary => ({
      identity: { scenarioId: "s", producerSlotId: "p0", iterationId, ...(workerId !== undefined ? { workerId } : {}) },
      durationMs,
      topEndpoints: [],
      truncated: false,
    });
    expect(compareSlow(s("w9", "it-9", 200), s("w0", "it-0", 100))).toBeLessThan(0); // duration first
    expect(compareSlow(s("w0", "it-2", 100), s("w1", "it-1", 100))).toBeLessThan(0); // then workerId
    expect(compareSlow(s(undefined, "it-9", 100), s("w0", "it-1", 100))).toBeLessThan(0); // absent sorts first
    expect(compareSlow(s("w0", "it-1", 100), s("w0", "it-2", 100))).toBeLessThan(0); // then iterationId
    expect(compareSlow(s("w0", "it-1", 100), s("w0", "it-1", 100))).toBe(0); // reflexive — a true total order
  });

  it("keeps failure traces deterministically on same-millisecond completion ties", () => {
    // Same three failures, same completion offset, three arrival orders → the SAME kept set:
    // ties break on iterationId, not arrival. (Pre-D0 the first arrivals won, so a
    // distributed merge could not reproduce local retention.)
    for (const arrival of [
      ["it-b", "it-a", "it-c"],
      ["it-c", "it-b", "it-a"],
      ["it-a", "it-c", "it-b"],
    ]) {
      const c = new LoadSampleCollector({ maxFailureTraces: 2 });
      for (const id of arrival) {
        c.beginIteration(id, { scenarioId: "s", producerSlotId: "p0" });
        c.endIteration(id, { ok: false, durationMs: 5, errorKind: "http", completedAtOffsetMs: 100 });
      }
      expect(c.finalize().failureTraces.map((f) => f.identity.iterationId)).toEqual(["it-a", "it-b"]);
    }
  });

  it("failure retention keeps the smallest completion offsets (a missing offset ranks last)", () => {
    const c = new LoadSampleCollector({ maxFailureTraces: 2 });
    for (const [id, at] of [["f-late", 300], ["f-early", 100], ["f-none", undefined], ["f-mid", 200]] as const) {
      c.beginIteration(id, { scenarioId: "s", producerSlotId: "p0" });
      c.endIteration(id, { ok: false, durationMs: 5, errorKind: "http", ...(at !== undefined ? { completedAtOffsetMs: at } : {}) });
    }
    // f-none (no offset → +∞) never displaces a stamped sample; f-mid displaces f-late.
    expect(c.finalize().failureTraces.map((f) => f.identity.iterationId)).toEqual(["f-early", "f-mid"]);
  });

  it("still ranks duration above the identity tie-break", () => {
    const c = new LoadSampleCollector({ maxSlowTransactionSummaries: 2 });
    // "it-z" sorts LAST by id, but its duration wins — the tie-break only decides equals.
    for (const [id, dur] of [["it-a", 100], ["it-z", 200], ["it-b", 100]] as const) {
      c.beginIteration(id, { scenarioId: "s", producerSlotId: "p0" });
      c.endIteration(id, { ok: true, durationMs: dur });
    }
    expect(c.finalize().slowTransactions.map((t) => t.identity.iterationId)).toEqual(["it-z", "it-a"]);
  });

  it("retains a deliberately-undefined assertion operand (presence flag)", () => {
    const c = new LoadSampleCollector();
    c.beginIteration("it", { scenarioId: "s", producerSlotId: "p0" });
    c.recordAssertionFailure("it", { tsOffsetMs: 0, message: "toBeUndefined", actual: undefined, hasActual: true, expected: 1, hasExpected: true });
    c.endIteration("it", { ok: false, durationMs: 1, errorKind: "assertion" });
    const obs = c.finalize().failureTraces[0].observations[0] as { actualPreview: unknown; expectedPreview: unknown };
    expect(obs.actualPreview).toBe("undefined"); // retained as a diagnostic, not dropped
    expect(obs.expectedPreview).toBe(1);
  });
});
