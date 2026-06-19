import { describe, expect, it } from "vitest";

import type { LoadArtifact, LoadProgressSnapshot, LoadReducer } from "@glubean/sdk/load";
import { LoadSink } from "./sink.js";

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
});
