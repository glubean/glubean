/**
 * End-to-end test for Phase 2f RFR v6 P1.1:
 *
 * Proves that the harness subprocess (NOT the parent CLI process)
 * eagerly loads `*.bootstrap.{ts,js,mjs}` files before importing the
 * user contract module. Without this, `contract.bootstrap()` registrations
 * declared in sibling files never reach the subprocess's bootstrap
 * registry, and a filtered run silently falls through to the no-overlay
 * path.
 *
 * Test approach (no real HTTP server needed):
 *   - Contract case declares `needs` (so the dispatcher cannot run raw).
 *   - Sibling `*.bootstrap.ts` registers an overlay whose `run` throws
 *     a unique sentinel error string.
 *   - CLI runs the contract file with `--filter` selecting just that case.
 *   - CLI exits non-zero AND output contains the sentinel (proves
 *     overlay was loaded + dispatched in the child process).
 *   - If harness eager-load were missing, the dispatcher's v3 P1 guard
 *     would fire with "declares `needs` but has no bootstrap overlay"
 *     instead — that's the regression mode.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-harness-overlay-e2e");
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
  // Per-test fixture; no global reset needed.
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("Phase 2f P1.1 — harness subprocess eagerly loads sibling overlays", () => {
  test("filtered run picks up sibling .bootstrap.ts and dispatches the overlay", async () => {
    const dir = await prepareFixture("sibling-overlay", {
      "package.json": workspacePackageJson("harness-overlay-e2e"),
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

const api = contract.http.with("usersApi", { endpoint: "https://example.invalid" });

export const getUsers = api("users.get", {
  endpoint: "GET /users",
  cases: {
    ok: {
      description: "fetch users",
      needs: tokenSchema,
      headers: ({ token }: { token: string }) => ({ authorization: \`Bearer \${token}\` }),
      expect: { status: 200 },
    },
  },
});
`,
      "tests/users.bootstrap.ts": `
import { contract } from "@glubean/sdk";
import { getUsers } from "./users.contract.js";

export const usersGetOverlay = contract.bootstrap(
  getUsers.case("ok"),
  async () => {
    // Unique sentinel proving the harness loaded this file in the
    // subprocess. If the parent-only eager-load were the only source,
    // the harness's bootstrap registry would be empty and the
    // dispatcher would hit the v3 P1 "declares \`needs\` but has no
    // bootstrap overlay" guard — a different observable failure mode.
    throw new Error("HARNESS_OVERLAY_RAN_SENTINEL_X42");
  },
);
`,
    });

    // Filter to JUST the contract file to isolate the §7.4 eager-load
    // requirement: a filtered run must still pick up sibling
    // *.bootstrap.ts registrations.
    const { code, stdout, stderr } = await runCli(
      ["run", "tests/users.contract.ts", "--no-session"],
      { cwd: dir },
    );
    const out = stdout + stderr;

    // Test fails (overlay's run threw) — non-zero exit.
    expect(code).not.toBe(0);

    // The sentinel from the overlay's run callback must appear in
    // output. This proves the harness loaded users.bootstrap.ts AND
    // dispatched the overlay path (NOT the no-overlay v3 P1 guard).
    expect(out).toContain("HARNESS_OVERLAY_RAN_SENTINEL_X42");

    // Negative assertion: must NOT see the no-overlay guard message.
    // If the harness eager-load regresses, this is the message we'd
    // get instead — and the test would catch it.
    expect(out).not.toMatch(
      /declares `needs` but has no bootstrap overlay/,
    );
  }, 60_000);
});
