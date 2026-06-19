import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadResultFileName, printOutcome, writeLoadResults, type LoadRunOutcome } from "./load.js";

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
