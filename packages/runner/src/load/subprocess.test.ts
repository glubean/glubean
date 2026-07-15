import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LoadPlan } from "@glubean/sdk/load";

import {
  collectLoadPlans,
  runLoadFileInSubprocess,
  withProcessEnvFallback,
} from "./subprocess.js";

// NOTE: runLoadFileInSubprocess spawns the BUILT dist/load-harness.js, so sdk +
// runner must be built before this test runs (pretest / CI build covers it).
//
// The fixtures live UNDER the runner package so the child's `@glubean/sdk/load`
// import resolves through the workspace (same approach as the cli load fixtures).

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(__dirname, "..", "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-load-subprocess");

let server: Server;
let base: string;
let requestCount = 0;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
  server = createServer((req, res) => {
    requestCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// A fixture that hits the mock server via ctx.http — exercises the FULL path
// (child resolves @glubean/sdk, runLoad + the scenario share one carrier, ky
// auto-trace flows through the engine sink). BASE_URL is injected at runtime
// since the fixture can't close over the parent's port.
const HTTP_FIXTURE = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/ping").json();
    ctx.expect(res.ok).toBe(true);
  })
  .build();
export const pingPlan = loadRunner("ping-plan", { scenario, concurrency: 2, iterations: 4 });
`;

describe("collectLoadPlans", () => {
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

describe("withProcessEnvFallback", () => {
  it("prefers the map, falls back to process.env for missing keys", () => {
    const KEY = "GLUBEAN_LOAD_SUBPROC_FALLBACK_XYZ";
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

describe("runLoadFileInSubprocess", () => {
  it("runs a real .load.ts in a child process against a mock server (vars injected)", async () => {
    const fixture = join(TMP_DIR, "ping.load.ts");
    await writeFile(fixture, HTTP_FIXTURE, "utf-8");
    const before = requestCount;

    const { outcomes, errors } = await runLoadFileInSubprocess(fixture, {
      vars: { BASE_URL: base },
      secrets: {},
      cwd: TMP_DIR,
    });

    expect(errors).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].runnerId).toBe("ping-plan");
    expect(outcomes[0].artifact.schemaVersion).toBe("glubean.load.v2");
    expect(outcomes[0].artifact.summary.totalIterations).toBe(4);
    expect(outcomes[0].artifact.summary.successfulIterations).toBe(4);
    expect(outcomes[0].artifact.summary.pass).toBe(true);
    // The scenario really hit the server — one request per iteration.
    expect(requestCount - before).toBe(4);
  });

  it("resolves BASE_URL from the child's process.env when absent from vars", async () => {
    const fixture = join(TMP_DIR, "env-fallback.load.ts");
    await writeFile(fixture, HTTP_FIXTURE, "utf-8");
    process.env.BASE_URL = base;
    try {
      const { outcomes, errors } = await runLoadFileInSubprocess(fixture, {
        vars: {}, // BASE_URL NOT in vars — must fall back to inherited process.env
        secrets: {},
        cwd: TMP_DIR,
      });
      expect(errors).toEqual([]);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].artifact.summary.pass).toBe(true);
    } finally {
      delete process.env.BASE_URL;
    }
  });

  it("records a per-file import error without throwing", async () => {
    const bad = join(TMP_DIR, "broken.load.ts");
    await writeFile(bad, `import "this-module-does-not-exist";\nexport const x = 1;\n`, "utf-8");

    const { outcomes, errors } = await runLoadFileInSubprocess(bad, {
      vars: {},
      secrets: {},
      cwd: TMP_DIR,
    });
    expect(outcomes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/failed to import load file/);
  });

  it("records a per-plan run error (unbounded plan) while still emitting valid plans", async () => {
    const fixture = join(TMP_DIR, "mixed.load.ts");
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

    const { outcomes, errors } = await runLoadFileInSubprocess(fixture, {
      vars: {},
      secrets: {},
      cwd: TMP_DIR,
    });
    expect(outcomes.map((o) => o.runnerId)).toEqual(["ok-plan"]); // valid plan still emitted
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/bad-plan.*failed/);
  });

  it("surfaces a crash that kills the child after a partial run (done sentinel)", async () => {
    // ok-plan completes + emits its artifact; boom-plan hard-exits mid-run, so the
    // child dies WITHOUT the `done` sentinel — a partial run must not be mistaken
    // for a complete one.
    // Export names drive run order (ESM namespace exports enumerate
    // alphabetically), so name the completing plan first and the crashing plan
    // last: ok runs + emits, then boom hard-exits.
    const fixture = join(TMP_DIR, "crash.load.ts");
    await writeFile(
      fixture,
      `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const ok = loadScenario("ok").step("noop", async () => {}).build();
const boom = loadScenario("boom").step("boom", async () => { process.exit(137); }).build();
export const aOkPlan = loadRunner("ok-plan", { scenario: ok, concurrency: 1, iterations: 1 });
export const zBoomPlan = loadRunner("boom-plan", { scenario: boom, concurrency: 1, iterations: 1 });
`,
      "utf-8",
    );

    const { outcomes, errors } = await runLoadFileInSubprocess(fixture, {
      vars: {},
      secrets: {},
      cwd: TMP_DIR,
    });
    expect(outcomes.map((o) => o.runnerId)).toEqual(["ok-plan"]); // partial result kept
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/did not complete/);
  });

  it("still parses protocol messages after user stdout with no trailing newline", async () => {
    // A load file that writes to stdout WITHOUT a trailing newline must not eat the
    // following artifact/done frames (the emit's leading newline reframes them).
    const fixture = join(TMP_DIR, "noisy.load.ts");
    await writeFile(
      fixture,
      `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
process.stdout.write("noisy-without-trailing-newline");
const scenario = loadScenario("s").step("noop", async () => {}).build();
export const p = loadRunner("noisy-plan", { scenario, concurrency: 1, iterations: 1 });
`,
      "utf-8",
    );

    const { outcomes, errors } = await runLoadFileInSubprocess(fixture, {
      vars: {},
      secrets: {},
      cwd: TMP_DIR,
    });
    expect(errors).toEqual([]); // not reported as an incomplete run
    expect(outcomes.map((o) => o.runnerId)).toEqual(["noisy-plan"]);
  });
});
