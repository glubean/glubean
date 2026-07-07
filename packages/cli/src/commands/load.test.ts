import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadResultFileName,
  printOutcome,
  writeLoadResults,
  resolveManyLoadTargets,
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
