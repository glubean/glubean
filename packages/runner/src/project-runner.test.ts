/**
 * Unit tests for `ProjectRunner`, focused on the finalize-invariant:
 * `executor.finalize()` MUST be drained regardless of how the generator
 * terminates (happy path, early return from orchestration failure,
 * iterator abandonment by consumer).
 *
 * Reviewer note (RF-1 Phase A round 1): the primary risk for the facade
 * is that some generator exit paths skip executor-level cleanup (e.g.
 * zero-project scratch teardown). These tests pin that invariant.
 *
 * We use `ProjectRunnerOptions.executor` (a test-injection hook added to
 * the public API — also legitimately useful for consumers who want to
 * pre-configure the executor) and spy on `finalize()` via `vi.spyOn`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProjectRunner } from "./project-runner.js";
import type { ProjectRunEvent } from "./project-runner.js";
import { TestExecutor } from "./executor.js";
import { LOCAL_RUN_DEFAULTS } from "./config.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "glubean-project-runner-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a ProjectRunner with empty tests + noSession against a temp dir
 * with no `glubean.setup.ts`. This avoids spawning any real subprocess:
 * the file loop has nothing to iterate, bootstrap finds no setup file,
 * session is skipped. Only the TestExecutor construction + finalize
 * contract remains under test.
 */
function buildMinimalRunner(options: { executor?: TestExecutor } = {}) {
  const executor = options.executor ?? TestExecutor.fromSharedConfig(
    LOCAL_RUN_DEFAULTS,
    { cwd: tmpRoot },
  );
  const runner = new ProjectRunner({
    rootDir: tmpRoot,
    sharedConfig: LOCAL_RUN_DEFAULTS,
    vars: {},
    secrets: {},
    tests: [],
    noSession: true,
    executor,
  });
  return { executor, runner };
}

describe("ProjectRunner finalize invariant", () => {
  test("finalize is called on happy-path completion", async () => {
    const { executor, runner } = buildMinimalRunner();
    const finalizeSpy = vi.spyOn(executor, "finalize");

    const events: ProjectRunEvent[] = [];
    for await (const e of runner.run()) events.push(e);

    // Verify we ran through the pipeline end-to-end.
    const types = events.map((e) => e.type);
    expect(types).toContain("bootstrap:done");
    expect(types).toContain("run:complete");

    // The finalize invariant:
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });

  test("finalize is called when consumer abandons the iterator after executor is built", async () => {
    // The invariant we pin: once `executor` is constructed (Phase 4 of the
    // pipeline), any subsequent early termination — consumer break, throw,
    // abort — must still drain finalize. Events before executor construction
    // (bootstrap:start/done, discovery:done) do NOT need finalize because
    // no executor exists yet. We break on the first post-construction event
    // (`session:discovered`) to exercise the try/finally boundary.
    const { executor, runner } = buildMinimalRunner();
    const finalizeSpy = vi.spyOn(executor, "finalize");

    for await (const e of runner.run()) {
      if (e.type === "session:discovered") break; // first event inside try block
    }

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });

  test("finalize is called even when caller throws during iteration (post-executor-construction)", async () => {
    const { executor, runner } = buildMinimalRunner();
    const finalizeSpy = vi.spyOn(executor, "finalize");

    const probe = new Error("consumer raised during iteration");
    await expect(async () => {
      for await (const e of runner.run()) {
        if (e.type === "session:discovered") throw probe; // inside try block
      }
    }).rejects.toThrow(probe);

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });

  test("break before executor is constructed does NOT call finalize (no resource to clean)", async () => {
    // Symmetric lower bound: if consumer bails before Phase 4 (e.g. after
    // bootstrap:start), no executor exists and finalize has nothing to do.
    // Asserting this explicitly so nobody later "fixes" the try/finally to
    // wrap bootstrap as well (which would construct-then-finalize even on
    // bootstrap failure — wasteful and confusing).
    const { executor, runner } = buildMinimalRunner();
    const finalizeSpy = vi.spyOn(executor, "finalize");

    for await (const _e of runner.run()) {
      break; // breaks on bootstrap:start, BEFORE executor construction
    }

    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  test("finalize errors are swallowed and do not mask primary run outcome", async () => {
    const { executor, runner } = buildMinimalRunner();

    // Force finalize to fail. We expect the run generator to complete
    // normally (yielding run:complete) without re-throwing.
    const finalizeSpy = vi.spyOn(executor, "finalize").mockImplementation(
      // eslint-disable-next-line require-yield
      async function* () {
        throw new Error("simulated finalize crash");
      },
    );

    const events: ProjectRunEvent[] = [];
    for await (const e of runner.run()) events.push(e);

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    // run:complete still emitted despite finalize exploding.
    expect(events.map((e) => e.type)).toContain("run:complete");
  });
});
