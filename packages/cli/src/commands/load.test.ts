import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadResultFileName,
  printOutcome,
  writeLoadResults,
  resolveManyLoadTargets,
  resolveLoadProviderChoice,
  LoadTargetResolutionError,
  type LoadRunOutcome,
} from "./load.js";

// NOTE: plan execution (discover → run → collect) now happens in a child process
// and is covered by `@glubean/runner`'s `runLoadFileInSubprocess` integration
// tests. What stays CLI-owned — and tested here — is the result filename
// sanitization + collision-safe artifact writing, plus the terminal summary print.

describe("loadResultFileName (M4-c)", () => {
  it("sanitizes a runner id into a safe filename", () => {
    expect(loadResultFileName("checkout-300")).toBe("checkout-300.load.result.json");
    expect(loadResultFileName("by region/us-east")).toBe("by_region_us-east.load.result.json");
    expect(loadResultFileName("///")).toBe("load.load.result.json");
  });
});

describe("writeLoadResults (M4-c)", () => {
  const mk = (id: string, artifact: Partial<LoadRunOutcome["artifact"]> = {}): LoadRunOutcome => ({
    file: "x.load.ts",
    runnerId: id,
    artifact: { runnerId: id, ...artifact } as unknown as LoadRunOutcome["artifact"],
  });

  it("writes each artifact to <id>.load.result.json", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "glubean-load-out-"));
    try {
      const written = await writeLoadResults(
        [mk("plan-a", { schemaVersion: "glubean.load.v1" } as Partial<LoadRunOutcome["artifact"]>)],
        outDir,
      );
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("plan-a.load.result.json");
      const parsed = JSON.parse(await readFile(written[0], "utf-8"));
      expect(parsed.schemaVersion).toBe("glubean.load.v1");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("disambiguates ids that sanitize to the same filename (no artifact lost)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "glubean-load-collide-"));
    try {
      // Both sanitize to "by_region_us-east.load.result.json"; "Checkout"/"checkout"
      // collide case-insensitively (macOS/Windows).
      const written = await writeLoadResults(
        [mk("by region/us-east"), mk("by_region_us-east"), mk("Checkout"), mk("checkout")],
        outDir,
      );
      expect(new Set(written.map((p) => p.toLowerCase())).size).toBe(4); // 4 DISTINCT entries
      expect(written[1]).toMatch(/-2\.load\.result\.json$/);
      expect(written[3]).toMatch(/-2\.load\.result\.json$/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("resolveManyLoadTargets (GLU-244 — profile load.plans → multiple targets)", () => {
  it("resolves each explicit-file target and preserves declaration order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glubean-load-many-"));
    try {
      await writeFile(join(dir, "a.load.ts"), "// a\n", "utf-8");
      await writeFile(join(dir, "b.load.ts"), "// b\n", "utf-8");
      const files = await resolveManyLoadTargets([
        join(dir, "b.load.ts"),
        join(dir, "a.load.ts"),
      ]);
      expect(files).toEqual([resolve(dir, "b.load.ts"), resolve(dir, "a.load.ts")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedupes a file discovered by more than one target (no double-run)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glubean-load-many-dedupe-"));
    try {
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "sub", "shared.load.ts"), "// shared\n", "utf-8");
      // Both the directory AND the explicit file resolve to the same path.
      const files = await resolveManyLoadTargets([
        join(dir, "sub"),
        join(dir, "sub", "shared.load.ts"),
      ]);
      expect(files).toEqual([resolve(dir, "sub", "shared.load.ts")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws LoadTargetResolutionError when a target resolves to no .load.ts files (GLU-244 codex R1 P1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glubean-load-many-empty-"));
    try {
      const missing = join(dir, "does-not-exist.load.ts");
      await expect(resolveManyLoadTargets([missing])).rejects.toThrow(LoadTargetResolutionError);
      await expect(resolveManyLoadTargets([missing])).rejects.toThrow(
        `No .load.ts files found for "${missing}".`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws naming ONLY the empty target(s) when one of several targets resolves to files and another doesn't (no silent partial success)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glubean-load-many-partial-empty-"));
    try {
      await writeFile(join(dir, "a.load.ts"), "// a\n", "utf-8");
      const missing = join(dir, "missing.load.ts");
      const err = await resolveManyLoadTargets([join(dir, "a.load.ts"), missing]).catch(
        (e) => e as LoadTargetResolutionError,
      );
      expect(err).toBeInstanceOf(LoadTargetResolutionError);
      expect((err as LoadTargetResolutionError).emptyTargets).toEqual([missing]);
      expect((err as Error).message).toContain(missing);
      expect((err as Error).message).not.toContain("a.load.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("printOutcome — phase-split display (M5)", () => {
  afterEach(() => vi.restoreAllMocks());

  const pct = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const outcome = (over: { primary?: unknown }): LoadRunOutcome =>
    ({
      runnerId: "checkout",
      artifact: {
        summary: {
          pass: true,
          totalIterations: 10,
          successfulIterations: 10,
          failedIterations: 0,
          errorRate: 0,
          throughputPerSec: 5,
          latency: { ...pct, p95: 120 },
          thresholds: [],
          ...(over.primary !== undefined ? { primary: over.primary } : {}),
        },
      },
    }) as unknown as LoadRunOutcome;

  it("prints a primary line (vs the end-to-end top line) when the split is present", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({ primary: { started: 10, completed: 10, failedBeforeRelease: 0, throughputPerSec: 8, latency: { ...pct, p95: 30 } } }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/primary \(to boundary\)/);
    expect(out).toMatch(/completed 10\/10/);
    expect(out).not.toMatch(/did not reach the primary boundary/); // full coverage
  });

  it("warns when fewer iterations complete primary than started", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({ primary: { started: 10, completed: 7, failedBeforeRelease: 3, throughputPerSec: 8, latency: { ...pct, p95: 30 } } }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/3 iteration\(s\) did not reach the primary boundary/);
  });

  it("omits the primary line for a closed run with no boundary", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({}));
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toMatch(/primary \(to boundary\)/);
  });
});

describe("printOutcome — continuation + advisory display (M6-e)", () => {
  afterEach(() => vi.restoreAllMocks());

  const pct = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const baseContinuation = {
    backlog: 0, maxBacklog: 3, maxConcurrent: 3, active: 0,
    releasedProducerSlots: 8, primaryBoundaryCoverage: 1, releaseCoverage: 1,
    duplicateReleaseSignals: 0, rejectedReleaseSignals: 0, abortedByDrainTimeout: 0,
  };
  const outcome = (over: { continuation?: unknown; advisories?: string[]; slotModel?: string }): LoadRunOutcome =>
    ({
      runnerId: "async-job",
      artifact: {
        runtime: { slotModel: over.slotModel ?? "producer-released" },
        summary: {
          pass: true,
          totalIterations: 10, successfulIterations: 10, failedIterations: 0,
          errorRate: 0, throughputPerSec: 5, latency: { ...pct, p95: 120 },
          thresholds: [],
          ...(over.continuation !== undefined ? { continuation: over.continuation } : {}),
          ...(over.advisories !== undefined ? { advisories: over.advisories } : {}),
        },
      },
    }) as unknown as LoadRunOutcome;

  it("prints a continuation line (slot model, released slots, backlog peak)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ continuation: { ...baseContinuation, backpressureMs: { ...pct, p95: 42 } } }));
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/continuation \(producer-released\)/);
    expect(out).toMatch(/released 8/);
    expect(out).toMatch(/backlog max 3/);
    expect(out).toMatch(/backpressure p95 42ms/);
  });

  it("warns on rejected releases and drain-timeout aborts", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({ continuation: { ...baseContinuation, rejectedReleaseSignals: 2, abortedByDrainTimeout: 1 } }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/2 release\(s\) rejected/);
    expect(out).toMatch(/1 continuation\(s\) aborted by the drain timeout/);
  });

  it("warns when only some iterations reached a primary boundary (partial coverage)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // A branched run: every reached boundary released (releaseCoverage 1), but only 60%
    // of iterations reached a boundary — the gap must still be surfaced.
    printOutcome(
      outcome({ continuation: { ...baseContinuation, primaryBoundaryCoverage: 0.6, releaseCoverage: 1 } }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/only 60\.00% of iterations reached a primary boundary/);
  });

  it("omits the continuation line for a closed run (no release)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({}));
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toMatch(/continuation \(/);
  });

  it("prints run-shape advisories", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ advisories: ["Most producer slot time is spent after the primary request; ..."] }));
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/Most producer slot time is spent after the primary request/);
  });
});

describe("printOutcome — tri-state thresholds (D0-T5)", () => {
  afterEach(() => vi.restoreAllMocks());

  const pct = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const outcome = (thresholds: unknown[], customMetrics?: unknown[]): LoadRunOutcome =>
    ({
      runnerId: "gated",
      artifact: {
        summary: {
          pass: false,
          totalIterations: 10,
          successfulIterations: 10,
          failedIterations: 0,
          errorRate: 0,
          throughputPerSec: 5,
          latency: { ...pct, p95: 120 },
          thresholds,
          ...(customMetrics !== undefined ? { customMetrics } : {}),
        },
      },
    }) as unknown as LoadRunOutcome;

  it("shows an unevaluable gate with its reason + interval, not as a plain ✗ breach", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome([
        {
          scope: "transaction",
          metric: "p95",
          expression: "<800ms",
          actual: 800,
          pass: false, // the conservative-degradation rule: unevaluable is never green
          status: "unevaluable",
          reason: "borderline-quantile",
          quantileBounds: { lower: 793.7, upper: 800 },
          source: "glubean",
        },
      ]),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/\? transaction\.p95 <800ms unevaluable \(borderline-quantile\)/);
    expect(out).toMatch(/interval \[793\.7, 800\.0\]ms/);
    // Not displayed as an ordinary breach (`.*` tolerates the ANSI reset after the mark).
    expect(out).not.toMatch(/✗.*transaction\.p95/);
  });

  it("shows a no-observations gate with its reason (no interval to print)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome([
        {
          scope: "step",
          target: "0:checkout",
          metric: "errorRate",
          expression: "<1%",
          actual: 0,
          pass: false,
          status: "unevaluable",
          reason: "no-observations",
          source: "glubean",
        },
      ]),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/\? step\[0:checkout\]\.errorRate <1% unevaluable \(no-observations\)/);
    expect(out).not.toMatch(/interval \[/);
  });

  it("labels a custom trend interval with the metric's DECLARED unit, not ms (codex R2)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome(
        [
          {
            // Tagged target form — the unit must resolve through the `${metricId}:` prefix match.
            scope: "customMetric",
            target: "payload:class=big",
            metric: "p95",
            expression: ">1000",
            actual: 1100,
            pass: false,
            status: "unevaluable",
            reason: "borderline-quantile",
            quantileBounds: { lower: 900, upper: 1100 },
            source: "glubean",
          },
        ],
        [{ metricId: "payload", kind: "trend", unit: "bytes", series: [] }],
      ),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/interval \[900\.0, 1100\.0\]bytes/); // a byte interval is NOT milliseconds
    expect(out).not.toMatch(/1100\.0\]ms/);
  });

  it("prints a bare-number interval for a trend with no declared unit", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome(
        [
          {
            scope: "customMetric",
            target: "score",
            metric: "p95",
            expression: ">90",
            actual: 95,
            pass: false,
            status: "unevaluable",
            reason: "borderline-quantile",
            quantileBounds: { lower: 88, upper: 95 },
            source: "glubean",
          },
        ],
        [{ metricId: "score", kind: "trend", series: [] }], // no unit declared → gates are bare numbers
      ),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    // Suffix-free: the interval closes straight into the ANSI reset escape.
    expect(out).toMatch(/interval \[88\.0, 95\.0\]/);
    expect(out).not.toMatch(/95\.0\]ms/);
  });

  it("keeps evaluated rows — and pre-v2 rows with no status — on the ✓/✗ path", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome([
        // A pre-tri-state row (no `status` field, e.g. an old result file): missing
        // status reads as evaluated → the ordinary breach display.
        { scope: "transaction", metric: "errorRate", expression: "<1%", actual: 0.02, pass: false, source: "glubean" },
        { scope: "transaction", metric: "p95", expression: "<800ms", actual: 120, pass: true, status: "evaluated", source: "glubean" },
      ]),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    // `.*` tolerates the ANSI reset sequence between the mark and the text.
    expect(out).toMatch(/✗.*transaction\.errorRate <1% \(actual 0\.02\)/);
    expect(out).toMatch(/✓.*transaction\.p95 <800ms \(actual 120\)/);
  });
});

describe("printOutcome — executionStatus display (D0-8, schema v2 §7.4)", () => {
  afterEach(() => vi.restoreAllMocks());

  const pct = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const outcome = (over: {
    executionStatus?: string;
    endReason?: string;
    pass?: boolean;
    execution?: unknown;
    crash?: unknown;
  }): LoadRunOutcome =>
    ({
      runnerId: "sharded",
      artifact: {
        runtime: {
          slotModel: "end-to-end",
          ...(over.execution !== undefined ? { execution: over.execution } : {}),
          ...(over.crash !== undefined ? { crash: over.crash } : {}),
        },
        summary: {
          pass: over.pass ?? false,
          totalIterations: 10,
          successfulIterations: 8,
          failedIterations: 2,
          errorRate: 0.2,
          throughputPerSec: 5,
          latency: { ...pct, p95: 120 },
          thresholds: [],
          ...(over.executionStatus !== undefined ? { executionStatus: over.executionStatus } : {}),
          ...(over.endReason !== undefined ? { endReason: over.endReason } : {}),
        },
      },
    }) as unknown as LoadRunOutcome;

  it("prints a prominent PARTIAL DATA warning with the coverage summary", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({
        executionStatus: "partial",
        execution: {
          provider: "multi-core",
          workerCount: 4,
          coverage: {
            workersFinal: 3,
            workersExpected: 4,
            slotSecondsAchieved: 92.5,
            slotSecondsExpected: 120,
            iterationsCompleted: 700,
            iterationsExpected: 1000,
          },
        },
      }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/PARTIAL DATA/);
    expect(out).toMatch(/informational only/);
    expect(out).toMatch(/workers 3\/4 final/);
    expect(out).toMatch(/slot-seconds 92\.5\/120\.0s/);
    expect(out).toMatch(/iterations 700\/1000/);
  });

  it("prints the PARTIAL DATA warning even without a coverage block", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ executionStatus: "partial" }));
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/PARTIAL DATA/);
    expect(out).not.toMatch(/coverage:/);
  });

  it("renders an absent iterationsCompleted as unknown, never 0/N (a lost counter is not zero completions)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({
        executionStatus: "partial",
        execution: {
          provider: "multi-core",
          workerCount: 4,
          coverage: {
            workersFinal: 3,
            workersExpected: 4,
            slotSecondsAchieved: 92.5,
            iterationsExpected: 1000, // expected known, completed UNKNOWN (absent)
          },
        },
      }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/iterations unknown\/1000/);
    expect(out).not.toMatch(/iterations 0\//);
  });

  it("prints an EXECUTION FAILED line for a failed status and SKIPS all metric rendering (placeholder numbers must not read as measurements)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({
        executionStatus: "failed",
      }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/EXECUTION FAILED/);
    expect(out).toMatch(/no usable merged result/);
    // No metric lines after the error: iterations/errorRate/p95/throughput are
    // placeholders on a failed run, not measurements.
    expect(out).not.toMatch(/iterations 10/);
    expect(out).not.toMatch(/p95/);
    expect(out).not.toMatch(/throughput/);
  });

  it("prints NOTHING extra for a complete run — and for a pre-v2 artifact with no status (zero noise on the single-machine path)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ executionStatus: "complete", pass: true }));
    printOutcome(outcome({ pass: true })); // pre-v2: no executionStatus field at all
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toMatch(/PARTIAL DATA/);
    expect(out).not.toMatch(/EXECUTION FAILED/);
  });

  it("surfaces an abnormal endReason: abort → warning line, crash → error line with the crash summary (§7.4)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ executionStatus: "complete", endReason: "abort" }));
    printOutcome(
      outcome({
        executionStatus: "complete",
        endReason: "crash",
        crash: { kind: "unhandledRejection", message: "boom", atMs: 10 },
      }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/run aborted before completing \(endReason: abort\)/);
    expect(out).toMatch(/run crashed \(endReason: crash\) — unhandledRejection: boom/);
  });

  it("prints NO endReason line for a normal duration/iterations end — or a pre-v2 artifact with no endReason", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ executionStatus: "complete", pass: true, endReason: "duration" }));
    printOutcome(outcome({ executionStatus: "complete", pass: true, endReason: "iterations" }));
    printOutcome(outcome({ pass: true })); // pre-v2: no endReason field at all
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toMatch(/run aborted/);
    expect(out).not.toMatch(/run crashed/);
    expect(out).not.toMatch(/endReason/);
  });

  it("shows a multi-core worker line (complete run) and surfaces a clamp note as a warning", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(
      outcome({
        executionStatus: "complete",
        pass: true,
        execution: {
          provider: "multi-core",
          workerCount: 2,
          notes: ["worker count clamped 4 → 2 (concurrency=2)"],
        },
      }),
    );
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/multi-core: 2 worker\(s\)/);
    expect(out).toMatch(/worker count clamped 4 → 2/);
  });

  it("prints NO multi-core line for a single-machine (in-process / pre-v2) run", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printOutcome(outcome({ executionStatus: "complete", pass: true, execution: { provider: "in-process", workerCount: 1 } }));
    printOutcome(outcome({ pass: true })); // pre-v2: no execution block at all
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).not.toMatch(/multi-core:/);
  });
});

describe("resolveLoadProviderChoice (proposal §5.2 — --provider / --workers)", () => {
  const posix4 = { platform: "linux" as NodeJS.Platform, cpuCount: 4 };

  it("defaults to in-process (and treats explicit in-process the same)", () => {
    expect(resolveLoadProviderChoice(undefined, undefined, posix4).provider).toEqual({ kind: "in-process" });
    expect(resolveLoadProviderChoice("in-process", undefined, posix4).provider).toEqual({ kind: "in-process" });
  });

  it("multi-core defaults the worker count to cores - 1", () => {
    const r = resolveLoadProviderChoice("multi-core", undefined, posix4);
    expect(r.provider).toEqual({ kind: "multi-core", workerCount: 3 });
    expect(r.warnings).toEqual([]);
  });

  it("honours the inline :N and lets --workers override it", () => {
    expect(resolveLoadProviderChoice("multi-core:2", undefined, posix4).provider).toEqual({ kind: "multi-core", workerCount: 2 });
    // --workers wins over the inline :N.
    expect(resolveLoadProviderChoice("multi-core:2", 5, posix4).provider).toEqual({ kind: "multi-core", workerCount: 5 });
  });

  it("rejects an unknown provider and a non-positive worker count", () => {
    expect(resolveLoadProviderChoice("distributed", undefined, posix4).error).toMatch(/Unknown --provider/);
    expect(resolveLoadProviderChoice("multi-core:0", undefined, posix4).error).toMatch(/positive integer/);
    expect(resolveLoadProviderChoice("multi-core", -1, posix4).error).toMatch(/positive integer/);
  });

  it("rejects a FRACTIONAL / garbage worker count instead of silently truncating it (P2-3)", () => {
    // main.ts parses --workers with Number() (not parseInt), so "2.5" arrives as 2.5 and "2foo"
    // as NaN — both must ERROR here, never silently run 2.
    expect(resolveLoadProviderChoice("multi-core", 2.5, posix4).error).toMatch(/positive integer/);
    expect(resolveLoadProviderChoice("multi-core", Number("2foo"), posix4).error).toMatch(/positive integer/);
    // The inline :N form is validated the same way.
    expect(resolveLoadProviderChoice("multi-core:2.5", undefined, posix4).error).toMatch(/positive integer/);
    expect(resolveLoadProviderChoice("multi-core:2foo", undefined, posix4).error).toMatch(/positive integer/);
  });

  it("flags multi-core on Windows as unsupported (falls back to in-process for the caller to steer)", () => {
    const r = resolveLoadProviderChoice("multi-core:2", undefined, { platform: "win32", cpuCount: 8 });
    expect(r.windowsUnsupported).toBe(true);
    expect(r.provider).toEqual({ kind: "in-process" });
  });

  it("warns (but proceeds) when multi-core is chosen on a single-core machine", () => {
    const r = resolveLoadProviderChoice("multi-core", undefined, { platform: "linux", cpuCount: 1 });
    expect(r.provider).toEqual({ kind: "multi-core", workerCount: 1 });
    expect(r.warnings.join(" ")).toMatch(/1 CPU core/);
  });

  it("warns that --workers has no effect without multi-core", () => {
    const r = resolveLoadProviderChoice("in-process", 4, posix4);
    expect(r.provider).toEqual({ kind: "in-process" });
    expect(r.warnings.join(" ")).toMatch(/--workers has no effect/);
  });
});
