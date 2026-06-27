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
