import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import type { LoadPlan } from "@glubean/sdk/load";

import {
  collectLoadPlans,
  loadResultFileName,
  runLoadFiles,
  withProcessEnvFallback,
  writeLoadResults,
  type LoadRunOutcome,
} from "./load.js";

describe("collectLoadPlans (M4-c)", () => {
  const plan = (id: string): LoadPlan =>
    ({ __glubean_type: "load-runner", id } as unknown as LoadPlan);

  it("collects single LoadPlan exports + flattens .each() arrays, ignoring others", () => {
    const ns = {
      a: plan("a"),
      each: [plan("b"), plan("c")],
      notAPlan: { __glubean_type: "load-scenario" },
      alsoNot: 42,
      arrayOfJunk: [1, 2, 3],
    };
    expect(collectLoadPlans(ns).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for a module with no load plans", () => {
    expect(collectLoadPlans({ x: 1, y: "z" })).toEqual([]);
  });
});

describe("withProcessEnvFallback (M4-c)", () => {
  it("prefers the map, falls back to process.env for missing keys", () => {
    const KEY = "GLUBEAN_LOAD_TEST_FALLBACK_XYZ";
    process.env[KEY] = "from-shell";
    try {
      const env = withProcessEnvFallback({ FROM_FILE: "file-value", EMPTY: "" });
      expect(env.FROM_FILE).toBe("file-value"); // map wins
      expect(env[KEY]).toBe("from-shell"); // process.env fallback
      // An empty map value is treated as missing → falls back to process.env.
      process.env.EMPTY = "shell-empty-override";
      expect(env.EMPTY).toBe("shell-empty-override");
      delete process.env.EMPTY;
      expect(KEY in env).toBe(true);
      expect("DEFINITELY_NOT_SET_ANYWHERE_123" in env).toBe(false);
      // Spreading exposes only the explicit map's keys, not the whole environment.
      expect(Object.keys({ ...env }).sort()).toEqual(["EMPTY", "FROM_FILE"]);
    } finally {
      delete process.env[KEY];
    }
  });
});

describe("loadResultFileName (M4-c)", () => {
  it("sanitizes a runner id into a safe filename", () => {
    expect(loadResultFileName("checkout-300")).toBe("checkout-300.load.result.json");
    expect(loadResultFileName("by region/us-east")).toBe("by_region_us-east.load.result.json");
    expect(loadResultFileName("///")).toBe("load.load.result.json");
  });
});

// ── Integration: discover → run → write, via a temp `.load.ts` fixture ──────────
// The fixture must live inside the cli package so its `@glubean/sdk/load` import
// resolves through the workspace (same approach as run-discovery's fixtures).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-load-cmd");

const FIXTURE = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("noop-scenario").step("noop", async () => {}).build();
export const planA = loadRunner("plan-a", { scenario, concurrency: 1, iterations: 3 });
export const notAPlan = { hello: "world" };
`;

describe("runLoadFiles + writeLoadResults (M4-c)", () => {
  afterAll(async () => {
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("imports a load file, runs its plan, and writes the artifact JSON", async () => {
    await mkdir(FIXTURE_ROOT, { recursive: true });
    const fixture = join(FIXTURE_ROOT, "fixture.load.ts");
    await writeFile(fixture, FIXTURE, "utf-8");

    const { outcomes, errors } = await runLoadFiles([fixture], { vars: {}, secrets: {} });
    expect(errors).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runnerId).toBe("plan-a");
    expect(outcomes[0].artifact.schemaVersion).toBe("glubean.load.v1");
    expect(outcomes[0].artifact.summary.totalIterations).toBe(3);
    expect(outcomes[0].artifact.summary.pass).toBe(true);

    const outDir = await mkdtemp(join(tmpdir(), "glubean-load-out-"));
    try {
      const written = await writeLoadResults(outcomes, outDir);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("plan-a.load.result.json");
      const parsed = JSON.parse(await readFile(written[0], "utf-8"));
      expect(parsed.schemaVersion).toBe("glubean.load.v1");
      expect(parsed.summary.totalIterations).toBe(3);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("disambiguates ids that sanitize to the same filename (no artifact lost)", async () => {
    const mk = (id: string): LoadRunOutcome => ({
      file: "x.load.ts",
      runnerId: id,
      artifact: { runnerId: id } as unknown as LoadRunOutcome["artifact"],
    });
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

  it("records a per-file import error without discarding other files' results", async () => {
    await mkdir(FIXTURE_ROOT, { recursive: true });
    const good = join(FIXTURE_ROOT, "good.load.ts");
    const bad = join(FIXTURE_ROOT, "broken.load.ts");
    await writeFile(good, FIXTURE, "utf-8");
    await writeFile(bad, `import "this-module-does-not-exist";\nexport const x = 1;\n`, "utf-8");

    // A broken file must NOT throw away the good file's completed result.
    const { outcomes, errors } = await runLoadFiles([good, bad], { vars: {}, secrets: {} });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runnerId).toBe("plan-a");
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe(bad);
    expect(errors[0].message).toMatch(/failed to import load file/);
  });

  it("records a per-plan run error (invalid plan) without dropping other outcomes", async () => {
    await mkdir(FIXTURE_ROOT, { recursive: true });
    // Two plans in one file: a valid one + an unbounded one (runLoad throws).
    const fixture = join(FIXTURE_ROOT, "mixed.load.ts");
    await writeFile(
      fixture,
      `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("s").step("noop", async () => {}).build();
export const ok = loadRunner("ok-plan", { scenario, concurrency: 1, iterations: 2 });
export const bad = loadRunner("bad-plan", { scenario, concurrency: 1 });
`,
      "utf-8",
    );

    const { outcomes, errors } = await runLoadFiles([fixture], { vars: {}, secrets: {} });
    expect(outcomes.map((o) => o.runnerId)).toEqual(["ok-plan"]); // valid plan persisted
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/bad-plan.*failed/);
  });
});
