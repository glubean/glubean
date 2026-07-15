/**
 * D1 — `shardPlan()` PURE-split tests (internal load-distributed-execution proposal
 * §5.1 / §6 / §9). Asserts the partition invariants a distributed run depends on:
 *  - concurrency: even split, remainder front-loaded from worker 0; slot bases tile
 *    [0, concurrency) (§6.1);
 *  - iterations: proportional quota laid out as CONTIGUOUS ranges tiling [0, iterations)
 *    with no gap/overlap; duration-only → disjoint strides whose union is every index
 *    (§6.2 / §6.3);
 *  - continuation: CONSERVING split (Σ shards === global bound, every shard ≥ 1) (§6.4);
 *  - feederSegments: proportional, disjoint, covering [0, size) for segmented strategies
 *    only; slot-indexed / seeded-random strategies carry no segment (§9);
 *  - §5.2 worker-count clamp under each binding constraint;
 *  - N === 1 degenerates to single-node semantics.
 * Plus property sweeps over (concurrency, iterations, N) for the global invariants.
 */
import { describe, expect, it } from "vitest";
import { feeder, loadRunner, loadScenario } from "@glubean/sdk/load";
import type {
  LoadContinuationConfig,
  LoadMixEntry,
  LoadPlan,
  LoadRunnerConfig,
} from "@glubean/sdk/load";
import { shardPlan, type IterationRange, type LoadShard } from "./shard.js";

// --- plan builders ------------------------------------------------------------------

const noopScenario = (id = "s") =>
  loadScenario(id)
    .step("noop", async () => {})
    .build();

/** Build a single-scenario plan from a partial config (scenario defaulted). */
function plan(config: Record<string, unknown>): LoadPlan {
  return loadRunner("test", {
    scenario: noopScenario(),
    ...config,
  } as unknown as LoadRunnerConfig);
}

/** Global iteration indexes owned by a stride shard within `[0, upto)`. */
function strideIndexes(offset: number, step: number, upto: number): number[] {
  const out: number[] = [];
  for (let i = offset; i < upto; i += step) out.push(i);
  return out;
}

function asRange(shard: LoadShard): IterationRange {
  if (shard.iterationIndexes.kind !== "range") {
    throw new Error(`expected a range shard, got ${shard.iterationIndexes.kind}`);
  }
  return shard.iterationIndexes;
}

// =============================================================================
// concurrency split (§6.1)
// =============================================================================

describe("shardPlan — concurrency split (§6.1)", () => {
  it("splits evenly with no remainder (300 / 4 → 75×4)", () => {
    const { shards } = shardPlan(plan({ concurrency: 300, iterations: 300 }), 4);
    expect(shards.map((s) => s.slotCount)).toEqual([75, 75, 75, 75]);
    expect(shards.map((s) => s.slotIndexBase)).toEqual([0, 75, 150, 225]);
    // globalConcurrency is the GLOBAL value on every shard (for rampDelayMs / partitionByVu).
    expect(shards.every((s) => s.globalConcurrency === 300)).toBe(true);
  });

  it("front-loads the remainder from worker 0 (301 / 4 → 76,75,75,75)", () => {
    const { shards } = shardPlan(plan({ concurrency: 301, iterations: 301 }), 4);
    expect(shards.map((s) => s.slotCount)).toEqual([76, 75, 75, 75]);
    expect(shards.map((s) => s.slotIndexBase)).toEqual([0, 76, 151, 226]);
  });

  it("slot bases tile [0, concurrency) with no gap or overlap", () => {
    const { shards } = shardPlan(plan({ concurrency: 17, iterations: 100 }), 5);
    let expectedBase = 0;
    for (const s of shards) {
      expect(s.slotIndexBase).toBe(expectedBase);
      expectedBase += s.slotCount;
    }
    expect(expectedBase).toBe(17); // last base + count === concurrency
    expect(shards.reduce((sum, s) => sum + s.slotCount, 0)).toBe(17);
  });

  it("assigns a stable positional workerId w0..wN-1", () => {
    const { shards } = shardPlan(plan({ concurrency: 12, iterations: 12 }), 3);
    expect(shards.map((s) => s.workerId)).toEqual(["w0", "w1", "w2"]);
  });
});

// =============================================================================
// iteration split — ranges (§6.2 / §6.3)
// =============================================================================

describe("shardPlan — iterations split into contiguous ranges (§6.3)", () => {
  it("splits [0, iterations) into proportional, contiguous, non-overlapping ranges", () => {
    // concurrency 10 / 4 → slotCounts 3,3,2,2; iterations 10 ∝ slots → quotas 3,3,2,2.
    const { shards } = shardPlan(plan({ concurrency: 10, iterations: 10 }), 4);
    const ranges = shards.map(asRange);
    expect(ranges).toEqual([
      { kind: "range", start: 0, end: 3 },
      { kind: "range", start: 3, end: 6 },
      { kind: "range", start: 6, end: 8 },
      { kind: "range", start: 8, end: 10 },
    ]);
  });

  it("uses largest-remainder for a non-even iteration quota (10 slots, 7 iterations)", () => {
    // slotCounts 3,3,2,2; ideal quotas 2.1,2.1,1.4,1.4 → floor 2,2,1,1 (Σ6), +1 to the
    // largest fractional (.4) → worker 2 → 2,2,2,1, tiling [0,7).
    const { shards } = shardPlan(plan({ concurrency: 10, iterations: 7 }), 4);
    const ranges = shards.map(asRange);
    expect(ranges.map((r) => r.end - r.start)).toEqual([2, 2, 2, 1]);
    expect(ranges[0].start).toBe(0);
    expect(ranges[3].end).toBe(7);
  });

  it("ranges tile [0, iterations) exactly — union is every index, once", () => {
    const iterations = 53;
    const { shards } = shardPlan(plan({ concurrency: 9, iterations }), 4);
    const covered: number[] = [];
    let prevEnd = 0;
    for (const s of shards) {
      const r = asRange(s);
      expect(r.start).toBe(prevEnd); // contiguous
      expect(r.end).toBeGreaterThanOrEqual(r.start);
      for (let i = r.start; i < r.end; i++) covered.push(i);
      prevEnd = r.end;
    }
    expect(prevEnd).toBe(iterations);
    expect(covered).toEqual([...Array(iterations).keys()]);
  });

  it("prefers iterations (range) over duration when a run is dual-bounded", () => {
    const { shards } = shardPlan(plan({ concurrency: 4, iterations: 8, duration: 1000 }), 2);
    expect(shards.every((s) => s.iterationIndexes.kind === "range")).toBe(true);
  });
});

// =============================================================================
// iteration split — strides (duration-only, §6.3)
// =============================================================================

describe("shardPlan — duration-only strides (§6.3)", () => {
  it("gives each worker a disjoint stride whose union is every index", () => {
    const N = 3;
    const { shards } = shardPlan(plan({ concurrency: 8, duration: 1000 }), N);
    expect(shards.map((s) => s.iterationIndexes)).toEqual([
      { kind: "stride", offset: 0, step: 3 },
      { kind: "stride", offset: 1, step: 3 },
      { kind: "stride", offset: 2, step: 3 },
    ]);
    // Disjoint + total coverage over a prefix of the index space.
    const seen = new Set<number>();
    for (const s of shards) {
      const stride = s.iterationIndexes;
      if (stride.kind !== "stride") throw new Error("expected stride");
      for (const i of strideIndexes(stride.offset, stride.step, 100)) {
        expect(seen.has(i)).toBe(false); // no overlap
        seen.add(i);
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(100).keys()]);
  });
});

// =============================================================================
// continuation split (§6.4)
// =============================================================================

describe("shardPlan — continuation conserving split (§6.4)", () => {
  it("splits maxOutstanding / maxConcurrent so shards sum EXACTLY to the global bound", () => {
    const continuation: LoadContinuationConfig = { maxOutstanding: 10, maxConcurrent: 6 };
    const { shards } = shardPlan(plan({ concurrency: 100, iterations: 100, continuation }), 4);
    const outstanding = shards.map((s) => s.continuation!.maxOutstanding!);
    const concurrent = shards.map((s) => s.continuation!.maxConcurrent!);
    expect(outstanding.reduce((a, b) => a + b, 0)).toBe(10);
    expect(concurrent.reduce((a, b) => a + b, 0)).toBe(6);
    expect(outstanding.every((x) => x >= 1)).toBe(true);
    expect(concurrent.every((x) => x >= 1)).toBe(true);
  });

  it("does NOT replicate a global bound onto every shard (4 across 4 → 1 each, not 4 each)", () => {
    const continuation: LoadContinuationConfig = { maxOutstanding: 4 };
    const { shards } = shardPlan(plan({ concurrency: 100, iterations: 100, continuation }), 4);
    expect(shards.map((s) => s.continuation!.maxOutstanding)).toEqual([1, 1, 1, 1]);
  });

  it("passes drainTimeout / minPollInterval / onBacklogFull through unchanged (time semantics)", () => {
    const continuation: LoadContinuationConfig = {
      maxOutstanding: 8,
      drainTimeout: "5s",
      minPollInterval: 200,
      onBacklogFull: "fail-iteration",
    };
    const { shards } = shardPlan(plan({ concurrency: 50, iterations: 50, continuation }), 3);
    for (const s of shards) {
      expect(s.continuation!.drainTimeout).toBe("5s");
      expect(s.continuation!.minPollInterval).toBe(200);
      expect(s.continuation!.onBacklogFull).toBe("fail-iteration");
    }
    expect(shards.map((s) => s.continuation!.maxOutstanding!).reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("omits shard.continuation entirely when the plan has none", () => {
    const { shards } = shardPlan(plan({ concurrency: 4, iterations: 4 }), 2);
    expect(shards.every((s) => s.continuation === undefined)).toBe(true);
  });

  it("global bound of 1 clamps to a single shard carrying the whole bound", () => {
    const continuation: LoadContinuationConfig = { maxOutstanding: 1 };
    const res = shardPlan(plan({ concurrency: 100, iterations: 100, continuation }), 4);
    expect(res.workerCount).toBe(1);
    expect(res.shards[0].continuation!.maxOutstanding).toBe(1);
  });
});

// =============================================================================
// feederSegments (§9)
// =============================================================================

describe("shardPlan — feeder row segments (§9)", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

  it("segments uniquePerIteration rows proportionally, disjoint, covering [0, size)", () => {
    const users = feeder.fromArray(rows(100));
    const { shards } = shardPlan(
      plan({ concurrency: 10, iterations: 10, feeders: { user: users.uniquePerIteration() } }),
      4,
    );
    const key = JSON.stringify(["shared", "user"]);
    const segs = shards.map((s) => s.feederSegments[key]);
    // slotCounts 3,3,2,2 → quotas 3,3,2,2 → 100 rows ∝ quota → 30,30,20,20.
    expect(segs).toEqual([
      { offset: 0, length: 30 },
      { offset: 30, length: 30 },
      { offset: 60, length: 20 },
      { offset: 80, length: 20 },
    ]);
  });

  it("segments roundRobin rows too (draws by run-global counter)", () => {
    const src = feeder.fromArray(rows(12));
    const { shards } = shardPlan(
      plan({ concurrency: 4, iterations: 8, feeders: { r: src.roundRobin() } }),
      2,
    );
    const key = JSON.stringify(["shared", "r"]);
    const segs = shards.map((s) => s.feederSegments[key]);
    expect(segs).toEqual([
      { offset: 0, length: 6 },
      { offset: 6, length: 6 },
    ]);
  });

  it("does NOT segment slot-indexed / seeded-random strategies", () => {
    const src = feeder.fromArray(rows(50), { key: "id" });
    for (const binding of [
      src.uniquePerVu(),
      src.partitionByVu(),
      src.random(),
      src.weightedRandom({ weight: "w" }),
    ]) {
      const { shards } = shardPlan(
        plan({ concurrency: 8, iterations: 20, feeders: { x: binding } }),
        4,
      );
      expect(shards.every((s) => Object.keys(s.feederSegments).length === 0)).toBe(true);
    }
  });

  it("splits a duration-only run's feeder rows by slot count", () => {
    const src = feeder.fromArray(rows(10));
    const { shards } = shardPlan(
      plan({ concurrency: 4, duration: 1000, feeders: { r: src.uniquePerIteration() } }),
      3,
    );
    // slotCounts 2,1,1 → 10 rows ∝ slots → 5,3,2 (largest remainder: ideals 5,2.5,2.5,
    // floor 5,2,2 Σ9 +1 to lower-index tie → worker 1) → 5,3,2.
    const key = JSON.stringify(["shared", "r"]);
    expect(shards.map((s) => s.feederSegments[key])).toEqual([
      { offset: 0, length: 5 },
      { offset: 5, length: 3 },
      { offset: 8, length: 2 },
    ]);
  });

  it("keys segments by canonical FeederSlotId for a traffic mix (shared vs entry)", () => {
    const shared = feeder.fromArray(rows(20));
    const bOwn = feeder.fromArray(rows(8));
    const use = (id: string) => loadScenario(id).step("noop", async () => {}).build();
    const mix = loadRunner("mix", {
      concurrency: 4,
      iterations: 8,
      feeders: { shared: shared.uniquePerIteration() },
      scenarios: [
        { id: "a", scenario: use("a"), weight: 50 } as LoadMixEntry,
        { id: "b", scenario: use("b"), weight: 50, feeders: { own: bOwn.uniquePerIteration() } } as LoadMixEntry,
      ],
    });
    const { shards } = shardPlan(mix, 2);
    const sharedKey = JSON.stringify(["shared", "shared"]);
    const entryKey = JSON.stringify(["entry", "b", "own"]);
    // Shared feeder (drawn by non-overriding entry a) → ["shared", name]; entry b's own → ["entry","b",name].
    expect(shards.every((s) => sharedKey in s.feederSegments)).toBe(true);
    expect(shards.every((s) => entryKey in s.feederSegments)).toBe(true);
    // Each tiles its own row space.
    expect(shards.map((s) => s.feederSegments[sharedKey].length).reduce((a, b) => a + b, 0)).toBe(20);
    expect(shards.map((s) => s.feederSegments[entryKey].length).reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("omits the shared slot when EVERY entry overrides that name", () => {
    const shared = feeder.fromArray(rows(20));
    const aOwn = feeder.fromArray(rows(6));
    const bOwn = feeder.fromArray(rows(6));
    const use = (id: string) => loadScenario(id).step("noop", async () => {}).build();
    const mix = loadRunner("mix2", {
      concurrency: 4,
      iterations: 8,
      feeders: { row: shared.uniquePerIteration() }, // overridden by BOTH entries
      scenarios: [
        { id: "a", scenario: use("a"), weight: 50, feeders: { row: aOwn.uniquePerIteration() } } as LoadMixEntry,
        { id: "b", scenario: use("b"), weight: 50, feeders: { row: bOwn.uniquePerIteration() } } as LoadMixEntry,
      ],
    });
    const { shards } = shardPlan(mix, 2);
    const sharedKey = JSON.stringify(["shared", "row"]);
    expect(shards.every((s) => !(sharedKey in s.feederSegments))).toBe(true);
    expect(shards.every((s) => JSON.stringify(["entry", "a", "row"]) in s.feederSegments)).toBe(true);
    expect(shards.every((s) => JSON.stringify(["entry", "b", "row"]) in s.feederSegments)).toBe(true);
  });
});

// =============================================================================
// §5.2 worker-count clamp
// =============================================================================

describe("shardPlan — worker-count clamp (§5.2)", () => {
  it("does not clamp when the request fits under every bound", () => {
    const res = shardPlan(plan({ concurrency: 100, iterations: 100 }), 2);
    expect(res.workerCount).toBe(2);
    expect(res.clampedFrom).toBeUndefined();
    expect(res.clampReason).toBeUndefined();
  });

  it("clamps to concurrency", () => {
    const res = shardPlan(plan({ concurrency: 4, iterations: 100 }), 8);
    expect(res.workerCount).toBe(4);
    expect(res.clampedFrom).toBe(8);
    expect(res.clampReason).toBe("concurrency=4");
  });

  it("clamps to iterations", () => {
    const res = shardPlan(plan({ concurrency: 100, iterations: 3 }), 8);
    expect(res.workerCount).toBe(3);
    expect(res.clampReason).toBe("iterations=3");
  });

  it("clamps to continuation.maxOutstanding", () => {
    const res = shardPlan(
      plan({ concurrency: 100, iterations: 100, continuation: { maxOutstanding: 2 } }),
      8,
    );
    expect(res.workerCount).toBe(2);
    expect(res.clampReason).toBe("continuation.maxOutstanding=2");
  });

  it("clamps to continuation.maxConcurrent", () => {
    const res = shardPlan(
      plan({ concurrency: 100, iterations: 100, continuation: { maxConcurrent: 5 } }),
      8,
    );
    expect(res.workerCount).toBe(5);
    expect(res.clampReason).toBe("continuation.maxConcurrent=5");
  });

  it("reports every tied binding constraint", () => {
    const res = shardPlan(plan({ concurrency: 4, iterations: 4 }), 8);
    expect(res.workerCount).toBe(4);
    expect(res.clampReason).toBe("concurrency=4, iterations=4");
  });
});

// =============================================================================
// N === 1 degenerate = single-node semantics
// =============================================================================

describe("shardPlan — single-worker degenerate (single-node equivalence)", () => {
  it("iterations-bounded: one shard with the full range [0, iterations) and full slots", () => {
    const { shards, workerCount } = shardPlan(plan({ concurrency: 8, iterations: 40 }), 1);
    expect(workerCount).toBe(1);
    expect(shards).toHaveLength(1);
    const s = shards[0];
    expect(s.slotIndexBase).toBe(0);
    expect(s.slotCount).toBe(8);
    expect(s.globalConcurrency).toBe(8);
    expect(s.iterationIndexes).toEqual({ kind: "range", start: 0, end: 40 });
  });

  it("duration-only: one shard with the full stride {offset:0, step:1}", () => {
    const { shards } = shardPlan(plan({ concurrency: 8, duration: 1000 }), 1);
    expect(shards[0].iterationIndexes).toEqual({ kind: "stride", offset: 0, step: 1 });
  });

  it("continuation stays at its original bounds (no split)", () => {
    const continuation: LoadContinuationConfig = { maxOutstanding: 5, maxConcurrent: 3 };
    const { shards } = shardPlan(plan({ concurrency: 8, iterations: 40, continuation }), 1);
    expect(shards[0].continuation).toMatchObject({ maxOutstanding: 5, maxConcurrent: 3 });
  });

  it("feeder gets the whole [0, size) segment", () => {
    const src = feeder.fromArray(Array.from({ length: 25 }, (_, i) => ({ i })));
    const { shards } = shardPlan(
      plan({ concurrency: 8, iterations: 40, feeders: { r: src.uniquePerIteration() } }),
      1,
    );
    expect(shards[0].feederSegments[JSON.stringify(["shared", "r"])]).toEqual({ offset: 0, length: 25 });
  });
});

// =============================================================================
// run-level passthrough (§6.1 / §6.6)
// =============================================================================

describe("shardPlan — run-level passthrough (not split)", () => {
  it("surfaces rampUp / duration / iterations / pacing unchanged on runLevel", () => {
    const res = shardPlan(
      plan({ concurrency: 10, iterations: 100, rampUp: "10s", pacing: { thinkTime: "1s" } }),
      4,
    );
    expect(res.runLevel).toEqual({
      concurrency: 10,
      rampUpMs: 10_000,
      iterations: 100,
      pacing: { thinkTime: "1s" },
    });
  });

  it("carries duration on runLevel for a duration-only run", () => {
    const res = shardPlan(plan({ concurrency: 4, duration: "30s" }), 2);
    expect(res.runLevel.durationMs).toBe(30_000);
    expect(res.runLevel.iterations).toBeUndefined();
  });
});

// =============================================================================
// input validation (pure function guards)
// =============================================================================

describe("shardPlan — input validation", () => {
  it("rejects a non-positive-integer workerCount", () => {
    expect(() => shardPlan(plan({ concurrency: 4, iterations: 4 }), 0)).toThrow(/workerCount/);
    expect(() => shardPlan(plan({ concurrency: 4, iterations: 4 }), 2.5)).toThrow(/workerCount/);
    expect(() => shardPlan(plan({ concurrency: 4, iterations: 4 }), -1)).toThrow(/workerCount/);
  });

  it("rejects a plan with no termination bound", () => {
    expect(() => shardPlan(plan({ concurrency: 4 }), 2)).toThrow(/termination bound/);
  });

  it("rejects a non-positive duration (mirrors runLoad), even when iterations are present", () => {
    // A present-but-zero duration has no dispatch window — reject up front, not shard.
    expect(() => shardPlan(plan({ concurrency: 4, duration: 0 }), 2)).toThrow(
      /duration must resolve to a positive number of ms/,
    );
    expect(() => shardPlan(plan({ concurrency: 4, duration: "0s" }), 2)).toThrow(
      /duration must resolve to a positive number of ms/,
    );
    // duration guard is INDEPENDENT of iterations: a dual-bound run with duration 0 still fails.
    expect(() => shardPlan(plan({ concurrency: 4, iterations: 8, duration: 0 }), 2)).toThrow(
      /duration must resolve to a positive number of ms/,
    );
    // Sanity: a valid duration with no iterations still shards (stride), unaffected.
    expect(shardPlan(plan({ concurrency: 4, duration: 1000 }), 2).shards[0].iterationIndexes.kind).toBe(
      "stride",
    );
  });

  it("rejects an invalid continuation bound", () => {
    expect(() =>
      shardPlan(plan({ concurrency: 4, iterations: 4, continuation: { maxOutstanding: 0 } }), 2),
    ).toThrow(/maxOutstanding/);
  });
});

// =============================================================================
// property sweeps — global invariants over (concurrency, iterations, N)
// =============================================================================

describe("shardPlan — property invariants", () => {
  const iterationValues = [1, 2, 3, 5, 7, 10, 13, 25, 100, 997];

  it("iterations-bounded: ranges always tile [0, iterations); slots always tile [0, concurrency)", () => {
    for (let concurrency = 1; concurrency <= 24; concurrency++) {
      for (const iterations of iterationValues) {
        const maxN = Math.min(concurrency, iterations, 8);
        for (let n = 1; n <= maxN; n++) {
          const { shards, workerCount } = shardPlan(plan({ concurrency, iterations }), n);
          expect(workerCount).toBe(n);
          // slots tile [0, concurrency)
          let base = 0;
          for (const s of shards) {
            expect(s.slotIndexBase).toBe(base);
            expect(s.slotCount).toBeGreaterThanOrEqual(0);
            base += s.slotCount;
          }
          expect(base).toBe(concurrency);
          // ranges tile [0, iterations)
          let prevEnd = 0;
          for (const s of shards) {
            const r = asRange(s);
            expect(r.start).toBe(prevEnd);
            expect(r.end).toBeGreaterThanOrEqual(r.start);
            prevEnd = r.end;
          }
          expect(prevEnd).toBe(iterations);
        }
      }
    }
  });

  it("duration-only: strides are disjoint and their union is every index", () => {
    for (let concurrency = 1; concurrency <= 16; concurrency++) {
      for (let n = 1; n <= Math.min(concurrency, 8); n++) {
        const { shards } = shardPlan(plan({ concurrency, duration: 1000 }), n);
        const seen = new Set<number>();
        for (const s of shards) {
          const stride = s.iterationIndexes;
          if (stride.kind !== "stride") throw new Error("expected stride");
          expect(stride.step).toBe(n);
          for (const i of strideIndexes(stride.offset, stride.step, 60)) {
            expect(seen.has(i)).toBe(false);
            seen.add(i);
          }
        }
        expect([...seen].sort((a, b) => a - b)).toEqual([...Array(60).keys()]);
      }
    }
  });

  it("continuation split always conserves the global bound with no zero quota", () => {
    for (const bound of [1, 2, 3, 5, 8, 13, 50, 100]) {
      for (let concurrency = 1; concurrency <= 16; concurrency++) {
        // N is clamped by the bound (§5.2), so every shard gets ≥ 1.
        const maxN = Math.min(concurrency, bound, 8);
        for (let n = 1; n <= maxN; n++) {
          const { shards, workerCount } = shardPlan(
            plan({ concurrency, iterations: 1000, continuation: { maxOutstanding: bound, maxConcurrent: bound } }),
            n,
          );
          const out = shards.map((s) => s.continuation!.maxOutstanding!);
          const con = shards.map((s) => s.continuation!.maxConcurrent!);
          expect(out.reduce((a, b) => a + b, 0)).toBe(bound);
          expect(con.reduce((a, b) => a + b, 0)).toBe(bound);
          expect(out.every((x) => x >= 1)).toBe(true);
          expect(con.every((x) => x >= 1)).toBe(true);
          expect(workerCount).toBe(n);
        }
      }
    }
  });

  it("feeder segments always tile [0, size) with no overlap", () => {
    const key = JSON.stringify(["shared", "r"]);
    for (const size of [0, 1, 4, 7, 50, 100]) {
      for (let concurrency = 1; concurrency <= 12; concurrency++) {
        for (let n = 1; n <= Math.min(concurrency, 6); n++) {
          const src = feeder.fromArray(Array.from({ length: size }, (_, i) => ({ i })));
          const { shards } = shardPlan(
            plan({ concurrency, iterations: 100, feeders: { r: src.uniquePerIteration() } }),
            n,
          );
          let offset = 0;
          for (const s of shards) {
            const seg = s.feederSegments[key];
            expect(seg.offset).toBe(offset);
            expect(seg.length).toBeGreaterThanOrEqual(0);
            offset += seg.length;
          }
          expect(offset).toBe(size); // union covers [0, size)
        }
      }
    }
  });

  it("is deterministic — same inputs, identical output", () => {
    const a = shardPlan(plan({ concurrency: 17, iterations: 53, continuation: { maxOutstanding: 9 } }), 5);
    const b = shardPlan(plan({ concurrency: 17, iterations: 53, continuation: { maxOutstanding: 9 } }), 5);
    expect(a).toEqual(b);
  });
});
