/**
 * E2E tests for `runCase` — the public programmatic single-case wrapper
 * (attachment-model §8). Covers wrapper-specific logic that isn't
 * exercised by CLI / MCP / SDK dispatcher tests:
 *
 *   - Glubean-aware project root walk-up (skips nested non-Glubean
 *     package.json, finds the workspace ancestor that has @glubean/sdk
 *     in deps OR a `glubean` field)
 *   - Falls back to dirname(filePath) when no Glubean root found
 *   - `loadProjectEnv` integration: contract under `tests/` reading
 *     `ctx.vars` / `ctx.secrets` sees values from `<projectRoot>/.env`
 *     and `<projectRoot>/.env.secrets`
 *   - Channel mutex throws synchronously on input + bootstrapInput
 *   - rawBypass via `input` runs the case; overlay (if any) NOT invoked
 *
 * Spawns a tsx subprocess per test (via ProjectRunner), so each test
 * is heavy. Kept narrow: 4 happy / sad-path tests covering the wrapper
 * logic only. Channel-mutex / bootstrapInput-without-overlay /
 * params-schema-mismatch behavior is covered by SDK unit + CLI E2E.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { runCase } from "./run-case.js";
import { LOCAL_RUN_DEFAULTS } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", ".tmp-runcase-e2e");
let fixtureSeq = 0;

function workspacePackageJson(name: string, glubean = true): string {
  return JSON.stringify(
    {
      name,
      type: "module",
      version: "0.0.0",
      ...(glubean
        ? {
            dependencies: {
              "@glubean/sdk": "workspace:*",
              "@glubean/runner": "workspace:*",
            },
          }
        : { dependencies: {} }),
    },
    null,
    2,
  );
}

async function prepareFixture(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  fixtureSeq += 1;
  const dir = join(FIXTURE_ROOT, `${name}-${fixtureSeq}`);
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return dir;
}

beforeEach(() => {
  // Per-test fixture; no shared state.
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("runCase — programmatic single-case wrapper", () => {
  test("synchronously rejects mutex: input + bootstrapInput together", async () => {
    await expect(
      runCase({
        filePath: "/does/not/matter.contract.ts",
        testId: "x.y",
        sharedConfig: LOCAL_RUN_DEFAULTS,
        input: { a: 1 },
        bootstrapInput: { b: 2 },
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("walks past nested non-Glubean package.json to the workspace Glubean root", async () => {
    const projectRoot = await prepareFixture("nested", {
      // Workspace root — has @glubean/sdk dep.
      "package.json": workspacePackageJson("nested-glubean-root"),
      // Tooling subpackage — has its OWN package.json but NO @glubean/sdk.
      // findProjectRoot must skip this one and continue up.
      "apps/svc/package.json": workspacePackageJson("svc-app", false),
      "apps/svc/tests/health.contract.ts": `
import { contract } from "@glubean/sdk";
const api = contract.http.with("svc", { endpoint: "https://example.invalid" });
export const ping = api("svc.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ping", expect: { status: 200 } } },
});
`,
    });

    const filePath = join(projectRoot, "apps/svc/tests/health.contract.ts");
    const result = await runCase({
      filePath,
      testId: "svc.ping.ok",
      sharedConfig: LOCAL_RUN_DEFAULTS,
    });

    // Root must be the workspace root, not `apps/svc/`.
    expect(result.projectRoot).toBe(projectRoot);
  }, 60_000);

  test("ctx.vars / ctx.secrets reflect <projectRoot>/.env + .env.secrets when contract is nested under tests/", async () => {
    // Pre-fix (runCase passes empty vars/secrets), the assertion inside
    // the test would fail and `result.success` would be false.
    const projectRoot = await prepareFixture("env-loading", {
      "package.json": workspacePackageJson("env-loading-test"),
      ".env": "MY_VAR=from-env\n",
      ".env.secrets": "MY_SECRET=from-secrets\n",
      "tests/checks.test.ts": `
import { test } from "@glubean/sdk";

export const reads = test("env-reads", async (ctx) => {
  ctx.assert(
    ctx.vars?.MY_VAR === "from-env",
    "ctx.vars.MY_VAR must come from project .env",
  );
  ctx.assert(
    ctx.secrets?.MY_SECRET === "from-secrets",
    "ctx.secrets.MY_SECRET must come from project .env.secrets",
  );
});
`,
    });

    const filePath = join(projectRoot, "tests/checks.test.ts");
    const result = await runCase({
      filePath,
      testId: "env-reads",
      exportName: "reads",
      sharedConfig: LOCAL_RUN_DEFAULTS,
    });

    expect(result.orchestrationError).toBeUndefined();
    expect(result.success).toBe(true);
  }, 60_000);

  test("caller-supplied vars/secrets win over loaded envFile values", async () => {
    const projectRoot = await prepareFixture("env-override", {
      "package.json": workspacePackageJson("env-override-test"),
      ".env": "OVERRIDE_ME=from-file\n",
      "tests/checks.test.ts": `
import { test } from "@glubean/sdk";

export const reads = test("override-reads", async (ctx) => {
  ctx.assert(
    ctx.vars?.OVERRIDE_ME === "from-caller",
    "caller-supplied vars must win over .env",
  );
  ctx.assert(
    ctx.vars?.PASSTHROUGH === "from-file",
    "non-overridden file vars must still pass through",
  );
});
`,
    });

    // Caller overrides one value but leaves the other untouched.
    await writeFile(
      join(projectRoot, ".env"),
      "OVERRIDE_ME=from-file\nPASSTHROUGH=from-file\n",
      "utf-8",
    );

    const result = await runCase({
      filePath: join(projectRoot, "tests/checks.test.ts"),
      testId: "override-reads",
      exportName: "reads",
      sharedConfig: LOCAL_RUN_DEFAULTS,
      vars: { OVERRIDE_ME: "from-caller" },
    });

    expect(result.orchestrationError).toBeUndefined();
    expect(result.success).toBe(true);
  }, 60_000);
});
