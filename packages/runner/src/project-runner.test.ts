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

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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

// For T2 tests below: a workspace-relative tmp dir so the spawned harness
// subprocess can resolve `@glubean/sdk` via the runner package's
// node_modules. Tmp-system dirs (used by the finalize-invariant tests
// above) have no SDK available, which is fine for those because they
// pass an empty `tests` array — the file loop never spawns.
const __filename = fileURLToPath(import.meta.url);
const RUNNER_ROOT = resolve(dirname(__filename), "..");
const FIXTURE_ROOT = join(RUNNER_ROOT, ".tmp-test-project-runner");
let fixtureSeq = 0;

beforeAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(FIXTURE_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true }).catch(() => {});
});

async function makeFixtureDir(): Promise<string> {
  const dir = join(FIXTURE_ROOT, String(fixtureSeq++));
  await mkdir(dir, { recursive: true });
  return dir;
}

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

// ---------------------------------------------------------------------------
// T2 — Data-driven export routing through harness exportName-only mode
// ---------------------------------------------------------------------------
//
// ProjectRunner detects template ids (e.g. `"demo-$key"`) emitted by the
// static parser for `test.each` / `test.pick` exports and routes them
// through the harness's exportName-only enumeration mode rather than
// stuffing the template through `--testIds=`. Pre-0.2.6 the template
// path silently fell back to `findTestByExport` which only ran the
// FIRST row (silent first-row-only bug B1).
//
// This test pins the contract: a ProjectRunnerTest with a template id
// MUST cause every per-row test to run and emit completed events with
// substituted ids.

import { writeFile, mkdir } from "node:fs/promises";

const T2_DATA_DRIVEN_FIXTURE = `
import { test } from "@glubean/sdk";

export const demoCases = test.each([
  { key: "alpha" },
  { key: "beta" },
  { key: "gamma" },
])(
  { id: "demo-$key", name: "demo $key" },
  async (ctx, { key }) => {
    ctx.assert(key.length > 0, "key non-empty for " + key);
  },
);
`;

describe("ProjectRunner data-driven export routing (T2)", () => {
  test("template-id meta routes through exportName-only mode and runs all rows", async () => {
    const fixtureDir = await makeFixtureDir();
    const fixturePath = join(fixtureDir, "data-driven.test.ts");
    await writeFile(fixturePath, T2_DATA_DRIVEN_FIXTURE);

    // Single ProjectRunnerTest with the TEMPLATE id — exactly what the
    // static parser emits for `test.each` exports today. Pre-0.2.6
    // ProjectRunner stuffed this into `--testIds=demo-$key` which the
    // harness couldn't resolve to a real Test.
    const runner = new ProjectRunner({
      rootDir: fixtureDir,
      sharedConfig: LOCAL_RUN_DEFAULTS,
      vars: {},
      secrets: {},
      tests: [{
        filePath: fixturePath,
        exportName: "demoCases",
        meta: {
          id: "demo-$key",
          name: "demo $key",
        },
      }],
      noSession: true,
    });

    const events: ProjectRunEvent[] = [];
    for await (const e of runner.run()) events.push(e);

    // Drill into file:event payloads — those carry the harness's per-test
    // status events with substituted ids.
    const completedIds: string[] = [];
    for (const ev of events) {
      if (ev.type !== "file:event") continue;
      const inner = (ev as { event: { type: string; status?: string; testId?: string; id?: string } }).event;
      if (inner.type === "status" && inner.status === "completed") {
        const id = inner.testId ?? inner.id;
        if (id) completedIds.push(id);
      }
    }

    completedIds.sort();
    expect(completedIds).toEqual(["demo-alpha", "demo-beta", "demo-gamma"]);

    // Sanity: run:complete is emitted at the end (no premature termination).
    expect(events.map((e) => e.type)).toContain("run:complete");
  }, 30_000);

  // ---------------------------------------------------------------------
  // Mixed file: static + data-driven exports MUST share one subprocess.
  //
  // The reviewer's P1 #2 (round 2) flagged that an earlier split impl
  // (one subprocess per partition) reloaded module state between
  // partitions, broke source order, and changed failFast semantics.
  // The current design routes through the harness's extended batch mode
  // — templates expand inside the harness in source order, all in one
  // process. This test pins that contract by relying on a module-level
  // `invocationOrder` counter: if any test ran in a fresh process the
  // counter would reset and the strict order assertions would fail.
  // ---------------------------------------------------------------------
  test("mixed file (static + data-driven exports) shares one subprocess preserving source order + module state", async () => {
    const fixtureDir = await makeFixtureDir();
    const fixturePath = join(fixtureDir, "mixed.test.ts");
    await writeFile(fixturePath, `
import { test } from "@glubean/sdk";

// Module-level counter — survives across tests IFF they run in the
// same Node process (single harness subprocess). Resets on fresh
// process spawn, which would happen if ProjectRunner split partitions
// into multiple subprocess.
let invocationOrder = 0;

export const staticHead = test(
  { id: "head-static" },
  async (ctx) => {
    invocationOrder++;
    ctx.assert(invocationOrder === 1, "head-static must run first (order=1), got " + invocationOrder);
  },
);

export const dataDrivenCases = test.each([
  { key: "alpha" },
  { key: "beta" },
])(
  { id: "case-$key" },
  async (ctx, { key }) => {
    invocationOrder++;
    // Source order: staticHead(1) → alpha(2) → beta(3) → tailStatic(4).
    // If a fresh subprocess fired between staticHead and the each block,
    // alpha would see invocationOrder=1 (counter reset). We strictly
    // assert >=2 to catch that case while tolerating either alpha-first
    // or beta-first within the same export.
    ctx.assert(invocationOrder >= 2, "case-" + key + " ran in a different subprocess (order=" + invocationOrder + ", expected >= 2)");
  },
);

export const staticTail = test(
  { id: "tail-static" },
  async (ctx) => {
    invocationOrder++;
    // After staticHead(1), case-alpha(2), case-beta(3) in the same
    // process, this MUST be 4. If splitting reset the counter, this
    // would be 1 or 2 depending on which subprocess this ran in.
    ctx.assert(invocationOrder === 4, "tail-static must be order=4, got " + invocationOrder);
  },
);
`);

    const runner = new ProjectRunner({
      rootDir: fixtureDir,
      sharedConfig: LOCAL_RUN_DEFAULTS,
      vars: {},
      secrets: {},
      // Source order matches the export order in the fixture file.
      // Critical: ProjectRunner preserves this order in `testIds`,
      // and the harness expands templates in-place without reordering.
      tests: [
        { filePath: fixturePath, exportName: "staticHead", meta: { id: "head-static", name: "head" } },
        { filePath: fixturePath, exportName: "dataDrivenCases", meta: { id: "case-$key", name: "case $key" } },
        { filePath: fixturePath, exportName: "staticTail", meta: { id: "tail-static", name: "tail" } },
      ],
      noSession: true,
    });

    const events: ProjectRunEvent[] = [];
    for await (const e of runner.run()) events.push(e);

    // Every test passed → module state was shared → single subprocess.
    const completedIds: string[] = [];
    const failedIds: string[] = [];
    for (const ev of events) {
      if (ev.type !== "file:event") continue;
      const inner = (ev as { event: { type: string; status?: string; testId?: string; id?: string; error?: string } }).event;
      if (inner.type === "status") {
        const id = inner.testId ?? inner.id ?? "?";
        if (inner.status === "completed") completedIds.push(id);
        else if (inner.status === "failed") failedIds.push(`${id}: ${inner.error ?? "?"}`);
      }
    }

    expect(failedIds).toEqual([]);

    // Order assertions:
    //  - head-static must come first
    //  - tail-static must come last
    //  - the two data-driven rows can be in either order between them
    expect(completedIds.length).toBe(4);
    expect(completedIds[0]).toBe("head-static");
    expect(completedIds[3]).toBe("tail-static");
    const middle = completedIds.slice(1, 3).sort();
    expect(middle).toEqual(["case-alpha", "case-beta"]);
  }, 30_000);

  test("static-id meta still routes through testIds batch path (no regression)", async () => {
    // A regular static-id test should NOT take the exportName-only path.
    // We can't directly observe which harness mode fired (no instrumentation
    // hook), but we can assert the run completes correctly with the static id.
    const STATIC_FIXTURE = `
import { test } from "@glubean/sdk";

export const ping = test(
  { id: "static-ping", name: "static ping" },
  async (ctx) => { ctx.assert(true, "ok"); },
);
`;
    const fixtureDir = await makeFixtureDir();
    const fixturePath = join(fixtureDir, "static.test.ts");
    await writeFile(fixturePath, STATIC_FIXTURE);

    const runner = new ProjectRunner({
      rootDir: fixtureDir,
      sharedConfig: LOCAL_RUN_DEFAULTS,
      vars: {},
      secrets: {},
      tests: [{
        filePath: fixturePath,
        exportName: "ping",
        meta: { id: "static-ping", name: "static ping" },
      }],
      noSession: true,
    });

    const events: ProjectRunEvent[] = [];
    for await (const e of runner.run()) events.push(e);

    const completedIds: string[] = [];
    for (const ev of events) {
      if (ev.type !== "file:event") continue;
      const inner = (ev as { event: { type: string; status?: string; testId?: string; id?: string } }).event;
      if (inner.type === "status" && inner.status === "completed") {
        const id = inner.testId ?? inner.id;
        if (id) completedIds.push(id);
      }
    }

    expect(completedIds).toEqual(["static-ping"]);
  }, 30_000);
});
