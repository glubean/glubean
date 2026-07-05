/**
 * GLU-221 phase 1 — local git provenance detection (`detectGitProvenance` /
 * `parseGitHubRepo`).
 *
 * Exercises the boundary-fallback discipline the design mandates: every
 * exceptional case (no repo, no commits, no remote, a non-GitHub remote,
 * a detached HEAD) must degrade to `null` (or a `null` sub-field) rather
 * than throw or emit a fabricated value (e.g. treating the literal string
 * "HEAD" from a detached checkout as a real branch name).
 *
 * Uses REAL git repos in isolated tmp directories (outside this checkout,
 * under `os.tmpdir()`) rather than mocking `child_process` — the exact
 * stdout shape of `git rev-parse`/`git remote get-url` for each boundary
 * case is the thing under test, so a mock would just restate the
 * implementation's assumptions instead of verifying them against real git.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectGitProvenance, parseGitHubRepo } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout;
}

async function initCommittedRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "a.txt"), "hello");
  await git(dir, ["add", "a.txt"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glubean-git-provenance-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseGitHubRepo", () => {
  test("parses git@github.com SSH shorthand", () => {
    expect(parseGitHubRepo("git@github.com:glubean/glubean.git")).toBe("glubean/glubean");
  });

  test("parses git@github.com SSH shorthand without .git suffix", () => {
    expect(parseGitHubRepo("git@github.com:glubean/glubean")).toBe("glubean/glubean");
  });

  test("parses ssh:// form", () => {
    expect(parseGitHubRepo("ssh://git@github.com/glubean/glubean.git")).toBe("glubean/glubean");
  });

  test("parses https:// form", () => {
    expect(parseGitHubRepo("https://github.com/glubean/glubean.git")).toBe("glubean/glubean");
  });

  test("parses https:// form without .git suffix", () => {
    expect(parseGitHubRepo("https://github.com/glubean/glubean")).toBe("glubean/glubean");
  });

  test("rejects a GitLab remote", () => {
    expect(parseGitHubRepo("git@gitlab.com:owner/repo.git")).toBeNull();
  });

  test("rejects a Bitbucket remote", () => {
    expect(parseGitHubRepo("https://bitbucket.org/owner/repo.git")).toBeNull();
  });

  test("rejects a self-hosted GitHub Enterprise host (not github.com)", () => {
    expect(parseGitHubRepo("https://github.acme-corp.internal/owner/repo.git")).toBeNull();
  });

  test("rejects a malformed URL", () => {
    expect(parseGitHubRepo("not a url")).toBeNull();
  });

  test("rejects an empty string", () => {
    expect(parseGitHubRepo("")).toBeNull();
  });

  // GLU-221 phase 1 P2-1 fix — a query string / fragment / credential must
  // never leak into the parsed repo id (it ships to the server as
  // `git.repo`). The old non-greedy regex backtracked `?token=xxx` into the
  // repo capture because nothing followed `.git` to anchor the match.
  test("strips a credential-bearing query string, never folding it into the repo id (https)", () => {
    expect(parseGitHubRepo("https://github.com/acme/app.git?token=SECRET123")).toBe("acme/app");
  });

  test("strips a query string with no .git suffix (https)", () => {
    expect(parseGitHubRepo("https://github.com/acme/app?token=SECRET123")).toBe("acme/app");
  });

  test("strips a fragment (https)", () => {
    expect(parseGitHubRepo("https://github.com/acme/app.git#readme")).toBe("acme/app");
  });

  test("strips a query string on the ssh:// form", () => {
    expect(parseGitHubRepo("ssh://git@github.com/acme/app.git?token=SECRET123")).toBe("acme/app");
  });

  test("a userinfo (e.g. token-as-username) in the URL is dropped, not folded into the repo id", () => {
    expect(parseGitHubRepo("https://oauth2:SECRET123@github.com/acme/app.git")).toBe("acme/app");
  });

  test("rejects a path with more than two segments (not a guessable owner/repo)", () => {
    expect(parseGitHubRepo("https://github.com/acme/app/extra")).toBeNull();
  });
});

describe("detectGitProvenance — boundary fallbacks (never throw, never fabricate)", () => {
  test("not a git repo at all → null", async () => {
    // `dir` is a plain tmp dir — `git init` was never run.
    await expect(detectGitProvenance(dir)).resolves.toBeNull();
  });

  test("git repo with zero commits (rev-parse HEAD fails) → null", async () => {
    await git(dir, ["init", "-q"]);
    await expect(detectGitProvenance(dir)).resolves.toBeNull();
  });

  test("commit exists but no origin remote configured → null", async () => {
    await initCommittedRepo(dir);
    await expect(detectGitProvenance(dir)).resolves.toBeNull();
  });

  test("origin is a non-GitHub remote (GitLab) → null", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@gitlab.com:owner/repo.git"]);
    await expect(detectGitProvenance(dir)).resolves.toBeNull();
  });

  test("origin is a non-GitHub remote (Bitbucket, https) → null", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "https://bitbucket.org/owner/repo.git"]);
    await expect(detectGitProvenance(dir)).resolves.toBeNull();
  });

  test("valid GitHub origin (SSH form) + normal branch → full provenance", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("acme/widgets");
    expect(result!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result!.branch).toBe("main");
  });

  test("valid GitHub origin (https form) → full provenance", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("acme/widgets");
    expect(result!.branch).toBe("main");
  });

  test("detached HEAD → branch is null, commit + repo still populated (no fabricated 'HEAD' branch name)", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["checkout", "-q", sha]);

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("acme/widgets");
    expect(result!.commit).toBe(sha);
    expect(result!.branch).toBeNull();
  });

  test("a shallow-clone-shaped repo (single commit, normal branch) resolves normally — no special-cased failure", async () => {
    // `git init` + one commit already IS the shallow-clone shape that
    // matters here (a single reachable commit, no ancestry needed for
    // rev-parse HEAD / remote get-url) — a real `--depth=1` clone needs a
    // network remote this test suite can't depend on, but the property
    // under test (shallow history doesn't break commit/remote resolution)
    // is fully exercised by a single-commit repo.
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("main");
  });

  test("never throws for a nonexistent directory", async () => {
    await expect(detectGitProvenance(join(dir, "does-not-exist"))).resolves.toBeNull();
  });

  // GLU-221 phase 1 P1 fix — `sync` uploads the CURRENT WORKING TREE, not
  // the HEAD commit. A dirty tree must not report `commit` (it would anchor
  // a Cloud deep link to a commit whose content doesn't match what was
  // actually uploaded) — `repo`/`branch` are unaffected.
  test("dirty working tree (uncommitted modification) → commit is null, repo/branch still populated", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    await writeFile(join(dir, "a.txt"), "modified, not committed");

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("acme/widgets");
    expect(result!.commit).toBeNull();
    expect(result!.branch).toBe("main");
  });

  test("dirty working tree (untracked new file) → commit is null", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    await writeFile(join(dir, "untracked.txt"), "new file, never added");

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.commit).toBeNull();
  });

  test("clean working tree (nothing after the init commit) → commit is populated, matches HEAD", async () => {
    await initCommittedRepo(dir);
    await git(dir, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();

    const result = await detectGitProvenance(dir);
    expect(result).not.toBeNull();
    expect(result!.commit).toBe(sha);
  });
});
