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
});
