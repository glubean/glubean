/**
 * End-to-end test for Spike 3 — runner input channels (attachment-model §8).
 *
 * Three CLI flags need round-trip coverage from CLI → env var → harness
 * subprocess → SDK runner-input channel → dispatcher §5.1 algorithm:
 *
 *   1. `--input-json` — explicit case input. Bootstrap overlay (if
 *      registered) must NOT be invoked; case runs raw with the input.
 *   2. `--bootstrap-json` — bootstrap params. Overlay's `params` schema
 *      validates the input; overlay's `run(ctx, params)` receives the
 *      validated value.
 *   3. `--force-standalone` — debug bypass for `requireAttachment` on
 *      no-needs cases. Emits a runtime warning.
 *
 * Each test uses a contract case whose body asserts the input it
 * received (via a sentinel string in the assertion message), so a
 * failed test surfaces the regression cleanly. No real HTTP server —
 * the action is a verify-only stub that captures `ctx`.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-runner-input-channels-e2e");
let fixtureSeq = 0;

function workspacePackageJson(name: string): string {
  return JSON.stringify(
    {
      name,
      type: "module",
      version: "0.0.0",
      dependencies: {
        "@glubean/sdk": "workspace:*",
        "@glubean/runner": "workspace:*",
      },
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

beforeEach(async () => {
  // Per-test fixture isolation; no shared state.
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("Spike 3 — runner input channels (attachment-model §8)", () => {
  test("--input-json: explicit input runs raw; overlay NOT invoked even when registered", async () => {
    const dir = await prepareFixture("input-json-wins", {
      "package.json": workspacePackageJson("spike3-input-json"),
      "tests/users.contract.ts": `
import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";

const tokenSchema: SchemaLike<{ token: string }> = {
  safeParse: (input: unknown) => {
    if (
      typeof input === "object" &&
      input !== null &&
      typeof (input as { token?: unknown }).token === "string"
    ) {
      return { success: true, data: input as { token: string } };
    }
    return { success: false, issues: [{ path: ["token"], message: "token required" }] };
  },
};

const api = contract.http.with("api", { endpoint: "https://example.invalid" });

export const getUsers = api("users.get", {
  endpoint: "GET /users",
  cases: {
    ok: {
      description: "fetch users",
      needs: tokenSchema,
      headers: ({ token }: { token: string }) => ({ authorization: \`B \${token}\` }),
      expect: { status: 200 },
      // Verify hook fires AFTER request fails; we use it to assert the
      // received input shape and emit a sentinel so the E2E sees it.
      verify: async (_ctx, _res) => {
        // Unreachable in this test — request to example.invalid fails
        // before verify. The test asserts via the dispatcher path log.
      },
    },
  },
});
`,
      "tests/users.bootstrap.ts": `
import { contract } from "@glubean/sdk";
import { getUsers } from "./users.contract.js";

// Overlay throws a sentinel. If the dispatcher invokes the overlay
// despite explicit --input-json being provided, the test sees this.
export const usersGetOverlay = contract.bootstrap(
  getUsers.case("ok"),
  async () => {
    throw new Error("OVERLAY_RAN_DESPITE_INPUT_JSON_SENTINEL");
  },
);
`,
    });

    const { stdout, stderr } = await runCli(
      [
        "run",
        "tests/users.contract.ts",
        "--filter",
        "users.get.ok",
        "--no-session",
        "--input-json",
        '{"token":"explicit-tk"}',
      ],
      { cwd: dir },
    );
    const out = stdout + stderr;

    // Overlay must NOT have run.
    expect(out).not.toContain("OVERLAY_RAN_DESPITE_INPUT_JSON_SENTINEL");

    // Test will fail (no real HTTP server) but we want to see the case
    // attempted via the raw path with the explicit input header. The
    // outgoing request to example.invalid surfaces in the trace as a
    // network error — not the overlay-thrown error. The simplest signal
    // we can rely on without inspecting trace internals: absence of the
    // overlay sentinel above + presence of the testId in output.
    expect(out).toContain("users.get.ok");

    // Sanity: the v3 P1 "no overlay registered" guard should NOT fire
    // either — we provided explicit input, so the dispatcher should
    // hit step 1 and skip the no-overlay error path.
    expect(out).not.toMatch(/declares `needs` but has no bootstrap overlay/);
  }, 60_000);

  test("--bootstrap-json: overlay's params schema validates input; overlay receives validated value", async () => {
    const dir = await prepareFixture("bootstrap-json", {
      "package.json": workspacePackageJson("spike3-bootstrap-json"),
      "tests/orders.contract.ts": `
import { contract } from "@glubean/sdk";

const api = contract.http.with("api", { endpoint: "https://example.invalid" });

export const getOrders = api("orders.list", {
  endpoint: "GET /orders",
  cases: {
    seeded: {
      description: "list seeded orders",
      expect: { status: 200 },
    },
  },
});
`,
      "tests/orders.bootstrap.ts": `
import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";
import { getOrders } from "./orders.contract.js";

const paramsSchema: SchemaLike<{ projectId: string }> = {
  safeParse: (input: unknown) => {
    if (
      typeof input === "object" &&
      input !== null &&
      typeof (input as { projectId?: unknown }).projectId === "string"
    ) {
      return { success: true, data: input as { projectId: string } };
    }
    return { success: false, issues: [{ path: ["projectId"], message: "projectId required" }] };
  },
};

// Overlay's run() echoes the params it received via a sentinel error
// message so the E2E test can verify the validated value reached run().
export const ordersOverlay = contract.bootstrap(getOrders.case("seeded"), {
  params: paramsSchema,
  run: async (_ctx, params) => {
    throw new Error(\`OVERLAY_RECEIVED_PROJECT_ID:\${params.projectId}\`);
  },
});
`,
    });

    const { stdout, stderr } = await runCli(
      [
        "run",
        "tests/orders.contract.ts",
        "--filter",
        "orders.list.seeded",
        "--no-session",
        "--bootstrap-json",
        '{"projectId":"p_99"}',
      ],
      { cwd: dir },
    );
    const out = stdout + stderr;

    // Sentinel proves: (a) overlay was invoked, (b) params survived
    // validation, (c) the projectId from CLI reached run().
    expect(out).toContain("OVERLAY_RECEIVED_PROJECT_ID:p_99");
  }, 60_000);

  test("--bootstrap-json: invalid input fails params schema validation; overlay run() not invoked", async () => {
    const dir = await prepareFixture("bootstrap-json-invalid", {
      "package.json": workspacePackageJson("spike3-bootstrap-json-invalid"),
      "tests/orders.contract.ts": `
import { contract } from "@glubean/sdk";

const api = contract.http.with("api", { endpoint: "https://example.invalid" });

export const getOrders = api("orders.list", {
  endpoint: "GET /orders",
  cases: {
    seeded: {
      description: "list seeded orders",
      expect: { status: 200 },
    },
  },
});
`,
      "tests/orders.bootstrap.ts": `
import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";
import { getOrders } from "./orders.contract.js";

// SchemaLike's failure shape is { success: false, error: { issues: [...] } }
// (matches Zod and validateNeedsOutput's expected shape).
const paramsSchema: SchemaLike<{ projectId: string }> = {
  safeParse: (input: unknown) => {
    if (
      typeof input === "object" &&
      input !== null &&
      typeof (input as { projectId?: unknown }).projectId === "string"
    ) {
      return { success: true, data: input as { projectId: string } };
    }
    return {
      success: false,
      error: { issues: [{ path: ["projectId"], message: "projectId required" }] },
    };
  },
};

export const ordersOverlay = contract.bootstrap(getOrders.case("seeded"), {
  params: paramsSchema,
  run: async () => {
    throw new Error("OVERLAY_RAN_DESPITE_BAD_PARAMS_SENTINEL");
  },
});
`,
    });

    const { stdout, stderr } = await runCli(
      [
        "run",
        "tests/orders.contract.ts",
        "--filter",
        "orders.list.seeded",
        "--no-session",
        "--bootstrap-json",
        '{"wrongShape":true}',
      ],
      { cwd: dir },
    );
    const out = stdout + stderr;

    // Validation error message visible.
    expect(out).toMatch(/Bootstrap params .* does not satisfy params schema/);
    // Overlay's run() must NOT have been reached.
    expect(out).not.toContain("OVERLAY_RAN_DESPITE_BAD_PARAMS_SENTINEL");
  }, 60_000);

  test("CLI rejects --input-json + --bootstrap-json supplied together (RFR-followup mutex)", async () => {
    const dir = await prepareFixture("mutex", {
      "package.json": workspacePackageJson("spike3-mutex"),
      "tests/users.contract.ts": `
import { contract } from "@glubean/sdk";
const api = contract.http.with("api", { endpoint: "https://example.invalid" });
export const getUsers = api("users.get", {
  endpoint: "GET /users",
  cases: { ok: { description: "fetch", expect: { status: 200 } } },
});
`,
    });

    const { code, stderr } = await runCli(
      [
        "run",
        "tests/users.contract.ts",
        "--filter",
        "users.get.ok",
        "--no-session",
        "--input-json",
        '{"x":1}',
        "--bootstrap-json",
        '{"y":2}',
      ],
      { cwd: dir },
    );

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--input-json and --bootstrap-json are mutually exclusive/);
  }, 60_000);

  test("CLI rejects --input-json when filter matches multiple tests", async () => {
    const dir = await prepareFixture("input-json-multi", {
      "package.json": workspacePackageJson("spike3-multi-match"),
      "tests/multi.contract.ts": `
import { contract } from "@glubean/sdk";

const api = contract.http.with("api", { endpoint: "https://example.invalid" });

export const c1 = api("svc.a", {
  endpoint: "GET /a",
  cases: {
    ok: { description: "case a", expect: { status: 200 } },
  },
});
export const c2 = api("svc.b", {
  endpoint: "GET /b",
  cases: {
    ok: { description: "case b", expect: { status: 200 } },
  },
});
`,
    });

    const { code, stderr } = await runCli(
      [
        "run",
        "tests/multi.contract.ts",
        "--filter",
        "ok",
        "--no-session",
        "--input-json",
        '{"x":1}',
      ],
      { cwd: dir },
    );

    expect(code).not.toBe(0);
    expect(stderr).toMatch(
      /require --filter to match exactly one testId.*Matched 2 tests/,
    );
  }, 60_000);
});
