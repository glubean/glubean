import { describe, it, expect } from "vitest";
import {
  MULTICORE_PROTOCOL_VERSION,
  MulticoreProtocolError,
  decodeCoordinatorMessage,
  decodeWorkerMessage,
  encodeCoordinatorMessage,
  encodeWorkerMessage,
  type CoordinatorMessage,
  type ShardAssignmentV1,
  type ShardResultObservablesV1,
  type WorkerMessage,
} from "./protocol.js";
import type { LoadShard } from "../shard.js";

const SHARD: LoadShard = {
  workerId: "w1",
  slotIndexBase: 2,
  slotCount: 2,
  globalConcurrency: 4,
  iterationIndexes: { kind: "range", start: 5, end: 10 },
  feederSegments: { '["shared","users"]': { offset: 3, length: 3 } },
};

const ASSIGNMENT: ShardAssignmentV1 = {
  file: "/abs/path/api.load.ts",
  planId: "my-plan",
  shard: SHARD,
  rngSeed: "seed-abc",
  vars: { BASE_URL: "http://localhost:1" },
  secrets: { TOKEN: "s3cr3t" },
  baseSession: { user: { id: 7 } },
  timelineOrigin: 1_700_000_000_000,
  snapshotIntervalMs: 25,
};

const OBSERVABLES: ShardResultObservablesV1 = {
  endReason: "iterations",
  finalizeNow: 1_700_000_001_234,
  mixOverrideUsed: false,
  peakContinuations: 3,
  abortedByDrainTimeout: 1,
  unreleasedTailPollRan: true,
  maxStartLatenessMs: 12,
};

// A minimal partial placeholder — decode only structurally checks `partial` is an object;
// deep validation is `parseLoadReducerPartial`'s job at merge (covered in provider.test.ts).
const PARTIAL_STUB = { v: 1, observedAt: 100 } as never;

describe("multicore protocol round-trip", () => {
  const coordinatorCases: CoordinatorMessage[] = [
    { type: "assign", assignment: ASSIGNMENT },
    { type: "assign", assignment: { ...ASSIGNMENT, baseSession: undefined, snapshotIntervalMs: undefined } },
    { type: "start", startAt: 1_700_000_000_500 },
    { type: "start", startAt: 1_700_000_000_500, dispatchDeadline: 1_700_000_030_500 },
    { type: "start", startAt: 1_700_000_000_500, timelineOrigin: 1_700_000_000_500 },
    { type: "start", startAt: 1_700_000_000_500, dispatchDeadline: 1_700_000_030_500, timelineOrigin: 1_700_000_000_500 },
    { type: "abort", reason: "coordinator requested" },
    { type: "heartbeat" },
    { type: "heartbeat", ts: 1_700_000_000_600 },
  ];
  it.each(coordinatorCases.map((m) => [m.type + JSON.stringify(m).slice(0, 20), m] as const))(
    "coordinator→worker %s survives encode→decode",
    (_label, msg) => {
      const decoded = decodeCoordinatorMessage(encodeCoordinatorMessage(msg));
      // Optional-undefined fields are dropped on the wire, so compare via JSON (undefined-insensitive).
      expect(JSON.parse(JSON.stringify(decoded))).toEqual(JSON.parse(JSON.stringify(msg)));
    },
  );

  const workerCases: WorkerMessage[] = [
    { type: "hello", protocolVersion: MULTICORE_PROTOCOL_VERSION, workerId: "w1", pid: 4242 },
    { type: "ready", workerId: "w1" },
    { type: "progress", workerId: "w1", observedAt: 123, iterationsStarted: 10, iterationsCompleted: 8 },
    { type: "snapshot", workerId: "w1", final: false, partial: PARTIAL_STUB },
    { type: "snapshot", workerId: "w1", final: true, partial: PARTIAL_STUB },
    { type: "result", workerId: "w1", observables: OBSERVABLES },
    { type: "error", workerId: "w1", message: "boom", stack: "at x" },
    { type: "error", message: "boom without worker id" },
    { type: "done", workerId: "w1" },
  ];
  it.each(workerCases.map((m) => [m.type + (("final" in m) ? String(m.final) : ""), m] as const))(
    "worker→coordinator %s survives encode→decode",
    (_label, msg) => {
      const decoded = decodeWorkerMessage(encodeWorkerMessage(msg));
      expect(JSON.parse(JSON.stringify(decoded))).toEqual(JSON.parse(JSON.stringify(msg)));
    },
  );

  it("stamps the current protocol version onto every encoded frame", () => {
    expect((encodeWorkerMessage({ type: "done", workerId: "w1" }) as { v: number }).v).toBe(MULTICORE_PROTOCOL_VERSION);
    expect((encodeCoordinatorMessage({ type: "abort", reason: "x" }) as { v: number }).v).toBe(MULTICORE_PROTOCOL_VERSION);
  });
});

describe("multicore protocol version incompatibility (rejected before assign, §4)", () => {
  it("rejects a worker frame stamped with a different protocol version", () => {
    const wire = { ...encodeWorkerMessage({ type: "hello", protocolVersion: 1, workerId: "w1", pid: 1 }), v: 999 };
    expect(() => decodeWorkerMessage(wire)).toThrow(MulticoreProtocolError);
    expect(() => decodeWorkerMessage(wire)).toThrow(/incompatible protocol version 999/);
  });

  it("rejects a coordinator frame stamped with a different protocol version", () => {
    const wire = { ...encodeCoordinatorMessage({ type: "abort", reason: "x" }), v: 2 };
    expect(() => decodeCoordinatorMessage(wire)).toThrow(MulticoreProtocolError);
  });

  it("rejects a frame with no version envelope at all", () => {
    expect(() => decodeWorkerMessage({ type: "done", workerId: "w1" })).toThrow(/incompatible protocol version/);
  });
});

describe("multicore protocol structural validation (cooperative trust)", () => {
  it("rejects a non-object frame", () => {
    expect(() => decodeWorkerMessage(null)).toThrow(MulticoreProtocolError);
    expect(() => decodeWorkerMessage("nope")).toThrow(/not an object/);
  });

  it("rejects an unknown message type", () => {
    expect(() => decodeWorkerMessage({ v: MULTICORE_PROTOCOL_VERSION, type: "bogus" })).toThrow(/unknown message type/);
    expect(() => decodeCoordinatorMessage({ v: MULTICORE_PROTOCOL_VERSION, type: "bogus" })).toThrow(/unknown message type/);
  });

  it("rejects a message missing a required field", () => {
    // hello without pid
    expect(() => decodeWorkerMessage({ v: MULTICORE_PROTOCOL_VERSION, type: "hello", protocolVersion: 1, workerId: "w1" })).toThrow(
      /'pid' must be a finite number/,
    );
    // assign without a shard
    expect(() =>
      decodeCoordinatorMessage({
        v: MULTICORE_PROTOCOL_VERSION,
        type: "assign",
        assignment: { file: "f", planId: "p", rngSeed: "s", vars: {}, secrets: {}, timelineOrigin: 0 },
      }),
    ).toThrow(/'shard' must be an object/);
    // snapshot without the final flag
    expect(() => decodeWorkerMessage({ v: MULTICORE_PROTOCOL_VERSION, type: "snapshot", workerId: "w1", partial: {} })).toThrow(
      /'final' must be a boolean/,
    );
  });
});
