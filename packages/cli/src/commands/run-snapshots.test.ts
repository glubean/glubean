/**
 * `glubean run` byte-for-byte snapshot fixtures (RF-1b Phase A).
 *
 * Purpose: regression oracle for Phase B of CLI runCommand → ProjectRunner
 * migration. These tests capture current CLI stdout on representative
 * fixture projects and freeze the output as golden strings. Phase B must
 * keep every snapshot byte-identical after normalization.
 *
 * Why in-repo snapshots instead of vitest `toMatchSnapshot()`: the output
 * is volatile (durations in ms, dates, trace ids, tmpdir paths). We
 * normalize before comparing; any new volatile bit must be explicitly
 * handled in `normalizeOutput` rather than silently absorbed.
 *
 * Fixtures live under `packages/cli/.tmp-run-snapshots/<name>/`. They're
 * INSIDE the CLI package tree so pnpm workspace resolution reaches
 * `@glubean/sdk` / `@glubean/runner` via hoisted node_modules. tmpdir
 * outside the package would fail to resolve workspace packages.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-run-snapshots");
const HOME = homedir();
let fixtureSeq = 0;

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
  // No global state to reset; each test creates its own fixture dir.
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

/**
 * Replace volatile CLI output (durations, dates, tmpdir paths, trace
 * ids, timestamps) with stable placeholders so the snapshot is
 * deterministic across runs.
 *
 * New volatile patterns discovered during Phase B must be added here
 * BEFORE the snapshot is re-accepted — never mask a diff by normalizing
 * away a real behavior change.
 */
export function normalizeOutput(raw: string): string {
  // Escape the current user's home path for inclusion in a regex literal.
  const homeEscaped = HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw
    // Strip ANSI escape sequences
    .replace(/\x1B\[[0-9;]*m/g, "")
    // Absolute fixture path: collapse the entire
    // "<anywhere>/packages/cli/.tmp-run-snapshots/<name>-<seq>" chain into
    // `<FIXTURE_DIR>` so snapshots are portable across dev / CI workspaces
    // regardless of where the repo is cloned.
    .replace(
      /\/[^\s]*\/packages\/cli\/\.tmp-run-snapshots\/[a-z-]+-\d+/g,
      "<FIXTURE_DIR>",
    )
    // Strip machine-specific home prefix for any surviving absolute paths
    // (trace file outputs, config discovery messages, etc.).
    .replace(new RegExp(homeEscaped, "g"), "<HOME>")
    // Timings: "123ms", "1.23s", "1234 ms"
    .replace(/\b\d+(\.\d+)?\s*ms\b/g, "<Nms>")
    .replace(/\b\d+(\.\d+)?\s*s\b/g, "<Ns>")
    // Memory footprint: "12.83 MB peak" / "512 KB peak" / "1.2 GB peak"
    .replace(/\b\d+(\.\d+)?\s+(MB|KB|GB|B)\b/gi, "<MEM>")
    // ISO date (Generated: 2026-04-23)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>")
    // ISO timestamps (Run at: ...)
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b/g,
      "<TIMESTAMP>",
    )
    // HH:MM:SS local time (per formatMdOutline + run headers)
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<TIME>")
    // Trailing whitespace per line (some output has trailing spaces)
    .replace(/ +$/gm, "")
    // Normalize trailing newlines (collapse 3+ → 2)
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Minimal SDK / runner workspace package.json used across fixtures.
 */
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

/** Variant with @glubean/graphql added (for plugin-registration fixtures). */
function workspacePackageJsonWithGraphql(name: string): string {
  return JSON.stringify(
    {
      name,
      type: "module",
      version: "0.0.0",
      dependencies: {
        "@glubean/sdk": "workspace:*",
        "@glubean/runner": "workspace:*",
        "@glubean/graphql": "workspace:*",
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Fixture: simple — one test file, 2 passing tests, no session/contracts
// ---------------------------------------------------------------------------

describe("glubean run — snapshot fixtures (RF-1b Phase A)", () => {
  test("simple: one test file with two passing tests", async () => {
    const dir = await prepareFixture("simple", {
      "package.json": workspacePackageJson("snapshot-simple"),
      "tests/hello.test.ts": `
import { test } from "@glubean/sdk";

export const greet = test("greet", async (ctx) => {
  ctx.assert(1 + 1 === 2, "arithmetic works");
});

export const farewell = test("farewell", async (ctx) => {
  ctx.assert("bye".length === 3, "string length");
});
`,
    });

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session"],
      { cwd: dir },
    );
    const normalized = normalizeOutput(stdout + stderr);

    // Structural assertions — the byte-exact oracle comes from the
    // Phase B diff, but these guards prevent wildly-wrong snapshots.
    expect(code).toBe(0);
    expect(normalized).toContain("🧪 Glubean Test Runner");
    expect(normalized).toContain("greet");
    expect(normalized).toContain("farewell");

    // Freeze the normalized output for Phase B comparison.
    expect(normalized).toMatchSnapshot();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Fixture: multi-file — two test files across two feature dirs
  // ---------------------------------------------------------------------------

  test("multi-file: two test files with per-file group headers", async () => {
    const dir = await prepareFixture("multi-file", {
      "package.json": workspacePackageJson("snapshot-multifile"),
      "tests/users/login.test.ts": `
import { test } from "@glubean/sdk";

export const loginOk = test("users.login.ok", async (ctx) => {
  ctx.assert(true, "login ok");
});
`,
      "tests/orders/checkout.test.ts": `
import { test } from "@glubean/sdk";

export const checkoutOk = test("orders.checkout.ok", async (ctx) => {
  ctx.assert(true, "checkout ok");
});
`,
    });

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session"],
      { cwd: dir },
    );
    const normalized = normalizeOutput(stdout + stderr);

    expect(code).toBe(0);
    expect(normalized).toContain("🧪 Glubean Test Runner");
    // Multi-file mode shows per-file group headers
    expect(normalized).toMatch(/📁\s+.+login\.test\.ts/);
    expect(normalized).toMatch(/📁\s+.+checkout\.test\.ts/);

    expect(normalized).toMatchSnapshot();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Fixture: mixed — session.ts + test file reading the session value
  // -------------------------------------------------------------------------

  test("mixed: session setup injects session value consumed by test", async () => {
    const dir = await prepareFixture("mixed", {
      "package.json": workspacePackageJson("snapshot-mixed"),
      "session.ts": `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  setup: async (ctx) => {
    ctx.session.set("greeting", "hello");
  },
});
`,
      "tests/uses-session.test.ts": `
import { test } from "@glubean/sdk";

export const readsSession = test("reads-session", async (ctx) => {
  const g = ctx.session.require("greeting");
  ctx.assert(g === "hello", "session value available");
});
`,
    });

    const { code, stdout, stderr } = await runCli(["run", "tests/"], {
      cwd: dir,
    });
    const normalized = normalizeOutput(stdout + stderr);

    // Structural guards (byte-exact check is the snapshot itself)
    expect(code).toBe(0);
    expect(normalized).toContain("Session:");
    expect(normalized).toContain("session value set");
    expect(normalized).toContain("reads-session");

    expect(normalized).toMatchSnapshot();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Fixture: fail-fast — three failing tests in one file, --fail-fast on.
  //
  // Subtle: current CLI evaluates the failure limit BETWEEN file groups,
  // not within a file. All 3 tests in this single-file fixture run, and
  // the snapshot captures that. If Phase B changes the granularity, the
  // snapshot diff will surface it.
  // -------------------------------------------------------------------------

  test("fail-fast: file-group-granularity failure short-circuit", async () => {
    const dir = await prepareFixture("fail-fast", {
      "package.json": workspacePackageJson("snapshot-failfast"),
      "tests/failing.test.ts": `
import { test } from "@glubean/sdk";

export const first = test("first-bad", async (ctx) => {
  ctx.assert(false, "intentionally failing #1");
});

export const second = test("second-bad", async (ctx) => {
  ctx.assert(false, "intentionally failing #2");
});

export const third = test("third-bad", async (ctx) => {
  ctx.assert(false, "intentionally failing #3");
});
`,
    });

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session", "--fail-fast"],
      { cwd: dir },
    );
    const normalized = normalizeOutput(stdout + stderr);

    expect(code).not.toBe(0); // non-zero exit on failure
    expect(normalized).toContain("first-bad");
    // Fail-fast: remaining two tests should NOT appear as executed
    // (exact wording depends on CLI but snapshot captures it)

    expect(normalized).toMatchSnapshot();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Fixture: test-level-requires — `requires: "browser"` on a `test(...)`
  // declaration (not a contract case). Current CLI does NOT filter on
  // test-level requires: both tests run. This snapshot captures that
  // behavior precisely so Phase B can surface any change (fixing the
  // filter, or preserving the quirk verbatim).
  // -------------------------------------------------------------------------

  test("test-level-requires: current CLI does not filter test() on requires", async () => {
    const dir = await prepareFixture("skip-requires", {
      "package.json": workspacePackageJson("snapshot-skipreq"),
      "tests/browser-only.test.ts": `
import { test } from "@glubean/sdk";

export const needsBrowser = test(
  { id: "needs-browser", requires: "browser" },
  async (ctx) => {
    ctx.assert(true, "would only run with --include-browser");
  },
);

export const runsAnyway = test("runs-anyway", async (ctx) => {
  ctx.assert(true, "default requires=headless");
});
`,
    });

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session"],
      { cwd: dir },
    );
    const normalized = normalizeOutput(stdout + stderr);

    expect(code).toBe(0); // skipped tests don't fail the run
    // One passes, one skipped with requires reason
    expect(normalized).toContain("runs-anyway");
    expect(normalized).toContain("needs-browser");

    expect(normalized).toMatchSnapshot();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Fixture: bootstrap-ran — proves runCommand now invokes bootstrap() via
  // ProjectRunner (RF-1b Phase B). Pre-migration CLI didn't call bootstrap,
  // so glubean.setup.ts was never evaluated. This fixture uses a setup.ts
  // that emits a stderr marker; its presence in captured output is direct
  // evidence bootstrap ran. If a future regression drops bootstrap again,
  // this snapshot diffs.
  // -------------------------------------------------------------------------

  test("bootstrap-ran: glubean.setup.ts side-effect shows up in CLI output", async () => {
    const dir = await prepareFixture("bootstrap-ran", {
      "package.json": workspacePackageJson("snapshot-bootstrap"),
      "glubean.setup.ts": `
// Intentional stderr marker. bootstrap(rootDir) imports this file;
// if bootstrap runs, the marker appears in captured stderr and locks
// the RF-1b bootstrap-fix behavior verbatim.
console.error("[bootstrap-fixture] setup.ts evaluated");
`,
      "tests/noop.test.ts": `
import { test } from "@glubean/sdk";

export const noop = test("bootstrap-sentinel", async (ctx) => {
  ctx.assert(true, "test runs after bootstrap");
});
`,
    });

    const { code, stdout, stderr } = await runCli(["run", "tests/"], {
      cwd: dir,
    });
    const normalized = normalizeOutput(stdout + stderr);

    expect(code).toBe(0);
    // The marker proves bootstrap() was called — pre-RF-1b the CLI
    // never did this, so this assertion alone would have failed then.
    expect(normalized).toContain("[bootstrap-fixture] setup.ts evaluated");
    expect(normalized).toContain("bootstrap-sentinel");

    expect(normalized).toMatchSnapshot();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Fixture: contract-case-requires-browser — HTTP contract case with
  // `requires: "browser"`, run without `--include-browser`. Current CLI's
  // shouldSkipTest filter catches contract-case-level requires (via meta
  // injected by dispatchContract) and emits the inline ⊘ skip line.
  //
  // The earlier `test-level-requires` fixture showed that `test()`
  // quick-mode does NOT hit this filter (a separate quirk); this one
  // covers the path that does, locking the "⊘ — skipped (requires:
  // browser)" layout Phase B preserves.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Fixture: bootstrap-plugin-registration — proves that the CLI-level
  // bootstrap() call actually reaches the plugin install path, not just
  // evaluates setup.ts.
  //
  // Pre-RF-1b: CLI never bootstrapped; a `.contract.ts` using
  // `contract.graphql.with(...)` would fail at CLI's extractContractFromFile
  // discovery (parent-process) because `contract.graphql` was undefined.
  // The run would surface 0 tests or an import error.
  //
  // Post-RF-1b: bootstrap() loads glubean.setup.ts → installPlugin(
  // graphqlPlugin) registers the graphql adapter on the contract namespace
  // → extractContractFromFile imports the contract file successfully →
  // the test is discovered + runs.
  //
  // The snapshot captures the post-RF-1b working path. Any regression that
  // breaks the bootstrap-to-installPlugin chain will make CLI's discovery
  // fail and surface a diff (either "No tests found" or an import error).
  // -------------------------------------------------------------------------

  test("bootstrap-plugin-registration: contract.graphql contract imports + runs after installPlugin", async () => {
    const dir = await prepareFixture("bootstrap-plugin", {
      "package.json": workspacePackageJsonWithGraphql("snapshot-bootstrap-plugin"),
      "glubean.setup.ts": `
import { installPlugin } from "@glubean/sdk";
import graphqlPlugin from "@glubean/graphql";
await installPlugin(graphqlPlugin);
`,
      "tests/users.contract.ts": `
import { contract } from "@glubean/sdk";

// Mock GraphQL client — we're testing the plugin-registration path,
// not the network. Returning a stable canned response so the case
// assertion passes deterministically.
const mockGqlClient: any = {
  query: async () => ({
    data: { user: { id: "u1" } },
    errors: undefined,
    httpStatus: 200,
    headers: {},
    rawBody: null,
  }),
  mutate: async () => ({
    data: null,
    errors: undefined,
    httpStatus: 200,
    headers: {},
    rawBody: null,
  }),
};

const gql = contract.graphql.with("users-api", { client: mockGqlClient });

export const getUser = gql("get-user", {
  cases: {
    ok: {
      description: "fetches a user",
      query: "query GetUser($id: ID!) { user(id: $id) { id } }",
      variables: { id: "u1" },
      expect: { data: { user: { id: "u1" } } },
    },
  },
});
`,
    });

    const { code, stdout, stderr } = await runCli(["run", "tests/"], {
      cwd: dir,
    });
    const normalized = normalizeOutput(stdout + stderr);

    // Direct evidence the plugin was registered and the contract imported:
    // the case's ID ("get-user.ok" or the display form) appears in output
    // with PASSED status. Pre-RF-1b this would've produced an import error
    // or "No tests found" because `contract.graphql` wasn't registered in
    // the CLI parent process during discovery.
    expect(code).toBe(0);
    expect(normalized).toContain("get-user");
    expect(normalized).toContain("PASSED");

    expect(normalized).toMatchSnapshot();
  }, 30_000);

  test("contract-case-requires-browser: inline ⊘ skip line between file header and runnable tests", async () => {
    const dir = await prepareFixture("cap-skip", {
      "package.json": workspacePackageJson("snapshot-capskip"),
      "tests/gated.contract.ts": `
import { contract } from "@glubean/sdk";

const mockClient: any = {
  get: () => ({ json: async () => ({}) }),
  post: () => ({ json: async () => ({}) }),
  put: () => ({ json: async () => ({}) }),
  delete: () => ({ json: async () => ({}) }),
  head: () => ({ json: async () => ({}) }),
  patch: () => ({ json: async () => ({}) }),
};
const api = contract.http.with("oauth-api", { client: mockClient });

export const oauthLogin = api("oauth-login", {
  endpoint: "POST /auth/oauth",
  cases: {
    headlessCheck: {
      description: "runs by default",
      expect: { status: 200 },
    },
    browserFlow: {
      description: "needs real browser",
      requires: "browser",
      expect: { status: 200 },
    },
  },
});
`,
    });

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session"],
      { cwd: dir },
    );
    const normalized = normalizeOutput(stdout + stderr);

    // The browser-required case must emit the ⊘ inline skip line.
    expect(normalized).toContain("⊘");
    expect(normalized).toMatch(/skipped \(.*browser/);
    // The headless case should still run normally.
    expect(normalized).toContain("headlessCheck");

    expect(normalized).toMatchSnapshot();
  }, 30_000);
});
