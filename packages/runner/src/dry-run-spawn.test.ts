import { test as vtest, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dryRunFiles } from "./dry-run-spawn.js";

// Integration: spawns the real tsx worker against test-project fixtures
// (test-project links @glubean/runner → this package's dist).
const testProject = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "test-project");

vtest(
  "watchdog kills a hanging projection and preserves earlier files' results",
  async () => {
    const good = resolve(testProject, "hello.test.ts");
    const hang = resolve(testProject, "_dryrun_hang.fixture.ts");
    // `good` is listed first so it streams its result before `hang` blocks.
    const res = await dryRunFiles([good, hang], { cwd: testProject, timeoutMs: 4000 });

    // Earlier file survived the kill.
    expect(res.shapes.some((s) => s.testId === "hello-world")).toBe(true);
    // Hanging file is reported as a timeout, not silently dropped — and the call
    // returned instead of hanging forever.
    expect(res.errors.some((e) => e.file === hang && /timed out/.test(e.message))).toBe(true);
  },
  20_000,
);

vtest(
  "public dryRunFiles folds bare branches into projectionComplete (no CLI patch)",
  async () => {
    const demo = resolve(testProject, "projection-demo.test.ts");
    const res = await dryRunFiles([demo], { cwd: testProject });
    const bare = res.shapes.find((s) => s.testId === "legacy-bare-if");
    expect(bare).toBeDefined();
    expect(bare!.projectionComplete).toBe(false);
    expect(bare!.incompleteReason).toMatch(/bare branch\/loop/);
  },
  20_000,
);

vtest(
  "a builder-only file yields an empty projection, not a worker error",
  async () => {
    const builderOnly = resolve(testProject, "_dryrun_builder_only.fixture.ts");
    const res = await dryRunFiles([builderOnly], { cwd: testProject });
    expect(res.shapes).toEqual([]);
    expect(res.errors).toEqual([]);
  },
  20_000,
);

vtest(
  "a worker exit after partial output flags the unreached file (abnormal & clean)",
  async () => {
    const good = resolve(testProject, "hello.test.ts");
    const boom = resolve(testProject, "_dryrun_exit.fixture.ts"); // process.exit(1)
    const boom0 = resolve(testProject, "_dryrun_exit0.fixture.ts"); // process.exit(0)

    const r1 = await dryRunFiles([good, boom], { cwd: testProject, timeoutMs: 8000 });
    expect(r1.errors.some((e) => e.file === boom && /not projected/.test(e.message))).toBe(true);

    // A CLEAN early exit (code 0) is just as lossy and must still be flagged.
    const r2 = await dryRunFiles([good, boom0], { cwd: testProject, timeoutMs: 8000 });
    expect(r2.errors.some((e) => e.file === boom0 && /not projected/.test(e.message))).toBe(true);
  },
  30_000,
);

vtest(
  "raw global fetch() is captured and hits no network (stubbed in the worker)",
  async () => {
    const rawFetch = resolve(testProject, "_dryrun_rawfetch.fixture.ts");
    // api.test is not a real host; if the stub failed this would error/hang.
    const res = await dryRunFiles([rawFetch], { cwd: testProject, timeoutMs: 8000 });
    const shape = res.shapes.find((s) => s.testId === "raw-fetch");
    expect(shape).toBeDefined();
    expect(shape!.projectionComplete).toBe(true);
    expect(shape!.endpoints).toContainEqual({
      method: "GET",
      url: "https://api.test/raw",
      branch: undefined,
    });
  },
  20_000,
);
