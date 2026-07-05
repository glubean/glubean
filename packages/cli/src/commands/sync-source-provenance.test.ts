/**
 * GLU-221 phase 1 — `glubean sync` uploads contract source location
 * (`sourceFile`/`line`/`endLine`) and local git provenance (`repo`/`commit`/
 * `branch`) alongside the existing contract projection.
 *
 * Three things pinned end-to-end through the REAL `syncCommand` pipeline
 * (scan → dry-run projection → redaction → upload body), not a
 * reimplementation of the wiring in the test:
 *
 *  1. Backward compatibility — a project with no git repo at all still syncs
 *     exactly as before, with `git: null` and no source fields fabricated.
 *  2. Git provenance — a real git repo with a GitHub `origin` remote
 *     produces `{ repo, commit, branch }` on the contract payload.
 *  3. Monorepo subdirectory rebasing — when the scanned project root is a
 *     SUBDIRECTORY of the git repo root, `sourceFile` is rebased to be
 *     relative to the repo root (not the scanned subpath), so a future
 *     Cloud deep link resolves against the real GitHub tree.
 *
 * Fixtures use a locally-defined duck-typed `contract.http(...)` factory
 * (no `import "@glubean/sdk"`) so these tests don't depend on workspace
 * module resolution and can live in a plain OS tmpdir — required for test 1
 * (a fixture inside this checkout would always appear to be "inside a git
 * repo" via the enclosing glubean repo itself).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { syncCommand } from "./sync.js";

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout;
}

async function initCommittedRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
}

/** A minimal duck-typed `contract.http` factory — no @glubean/sdk needed,
 * written in the literal call form the static line-lookup extractor
 * recognizes (`contract.<protocol>("id", { cases: {...} })`). */
function contractFixtureSource(): string {
  return `const contract = {
  http(id, spec) {
    const cases = Object.entries(spec.cases ?? {}).map(([key, c]) => ({
      key,
      lifecycle: "active",
      severity: "warning",
      description: c?.description,
    }));
    const projection = { id, protocol: "http", target: spec.endpoint, cases };
    const arr = [];
    Object.assign(arr, { _projection: projection, _extracted: projection });
    return arr;
  },
};

export const getWidget = contract.http("get-widget", {
  endpoint: "GET /widgets/:id",
  cases: {
    ok: { description: "found" },
  },
});
`;
}

/** `findProjectConfig` recognizes a glubean project by an `@glubean/sdk`
 * dependency ENTRY in package.json — it never resolves the package, so a
 * fixture that duck-types the SDK (never actually imports it) can declare
 * the entry without the real package being installed. */
function minimalPackageJson(name: string): string {
  return JSON.stringify(
    { name, type: "module", version: "0.0.0", dependencies: { "@glubean/sdk": "*" } },
    null,
    2,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Find the POST body sent to `${base}/${kind}` — sync.ts posts test/contract/
 * workflow/openapi separately; locate by URL suffix rather than call order. */
function bodyForKind(fetchMock: ReturnType<typeof vi.fn>, kind: string): any {
  const call = fetchMock.mock.calls.find(([url]: [string]) => (url as string).endsWith(`/${kind}`));
  expect(call, `no fetch call for kind "${kind}"`).toBeDefined();
  return JSON.parse(call![1].body as string);
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function freshTmpDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ upserted: 1 })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fetchMock;
}

describe("GLU-221 phase 1 — sync source location + git provenance", () => {
  test("backward compatible: no git repo → git is null, sourceFile is still project-root-relative, rest of the payload is unaffected", async () => {
    const dir = await freshTmpDir("glubean-sync-provenance-nogit-");
    await mkdir(join(dir, "contracts"), { recursive: true });
    await writeFile(join(dir, "package.json"), minimalPackageJson("nogit-fixture"));
    await writeFile(join(dir, "contracts", "widgets.contract.ts"), contractFixtureSource());
    const fetchMock = stubFetch();

    await syncCommand({
      dir,
      token: "gb_test_token",
      project: "proj_test",
      apiUrl: "https://api.glubean.test",
      allowEmpty: true,
    });

    const contractBody = bodyForKind(fetchMock, "contract");
    expect(contractBody.git).toBeNull();
    expect(contractBody.contracts).toHaveLength(1);
    const c = contractBody.contracts[0];
    expect(c.contractId).toBe("get-widget");
    expect(c.protocol).toBe("http");
    expect(c.sourceFile).toBe(join("contracts", "widgets.contract.ts"));
    expect(typeof c.line).toBe("number");
    expect(typeof c.endLine).toBe("number");
    // Untouched fields keep their pre-GLU-221 shape.
    expect(c.projection.id).toBe("get-widget");
    expect(c.caseCount).toBe(1);
  });

  test("git repo with a GitHub origin remote → contract payload carries repo/commit/branch", async () => {
    const dir = await freshTmpDir("glubean-sync-provenance-git-");
    await mkdir(join(dir, "contracts"), { recursive: true });
    await writeFile(join(dir, "package.json"), minimalPackageJson("git-fixture"));
    await writeFile(join(dir, "contracts", "widgets.contract.ts"), contractFixtureSource());
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const fetchMock = stubFetch();

    await syncCommand({
      dir,
      token: "gb_test_token",
      project: "proj_test",
      apiUrl: "https://api.glubean.test",
      allowEmpty: true,
    });

    const contractBody = bodyForKind(fetchMock, "contract");
    expect(contractBody.git).not.toBeNull();
    expect(contractBody.git.repo).toBe("acme/widgets");
    expect(contractBody.git.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(contractBody.git.branch).toBe("main");
    // Project root === repo root here, so sourceFile is unchanged by rebasing.
    expect(contractBody.contracts[0].sourceFile).toBe(join("contracts", "widgets.contract.ts"));
  });

  test("monorepo subdirectory: sourceFile is rebased relative to the git repo root, not the scanned project root", async () => {
    const repoRoot = await freshTmpDir("glubean-sync-provenance-monorepo-");
    const projectDir = join(repoRoot, "packages", "app");
    await mkdir(join(projectDir, "contracts"), { recursive: true });
    await writeFile(join(projectDir, "package.json"), minimalPackageJson("monorepo-app"));
    await writeFile(join(projectDir, "contracts", "widgets.contract.ts"), contractFixtureSource());
    await initCommittedRepo(repoRoot);
    await git(repoRoot, ["remote", "add", "origin", "https://github.com/acme/monorepo.git"]);
    const fetchMock = stubFetch();

    await syncCommand({
      dir: projectDir,
      token: "gb_test_token",
      project: "proj_test",
      apiUrl: "https://api.glubean.test",
      allowEmpty: true,
    });

    const contractBody = bodyForKind(fetchMock, "contract");
    expect(contractBody.git.repo).toBe("acme/monorepo");
    // Rebased: "packages/app/contracts/widgets.contract.ts" (repo-root-
    // relative), NOT "contracts/widgets.contract.ts" (project-root-relative).
    expect(contractBody.contracts[0].sourceFile).toBe(
      join("packages", "app", "contracts", "widgets.contract.ts"),
    );
  });
});
