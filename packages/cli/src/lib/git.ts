/**
 * Git helper utilities for the Glubean CLI.
 */

import { execFile } from "node:child_process";
import { resolve, relative } from "node:path";

function execGit(args: string[], cwd?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    execFile("git", args, { cwd, encoding: "utf-8" }, (error, stdout) => {
      if (error) {
        res({ code: error.code ? 1 : 1, stdout: "" });
      } else {
        res({ code: 0, stdout: stdout ?? "" });
      }
    });
  });
}

export async function isGitRepo(dir?: string): Promise<boolean> {
  try {
    const { code } = await execGit(["rev-parse", "--is-inside-work-tree"], dir);
    return code === 0;
  } catch {
    return false;
  }
}

export async function gitShow(
  ref: string,
  filePath: string,
  dir?: string,
): Promise<string | null> {
  try {
    const { code, stdout } = await execGit(["show", `${ref}:${filePath}`], dir);
    if (code !== 0) return null;
    return stdout;
  } catch {
    return null;
  }
}

export async function gitRoot(dir?: string): Promise<string | null> {
  try {
    const { code, stdout } = await execGit(["rev-parse", "--show-toplevel"], dir);
    if (code !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitRelativePath(
  filePath: string,
  dir?: string,
): Promise<string | null> {
  try {
    const { code, stdout } = await execGit(["ls-files", "--full-name", filePath], dir);
    if (code !== 0) return null;
    const result = stdout.trim();
    if (!result) {
      const rootDir = await gitRoot(dir);
      if (!rootDir) return null;
      const absPath = resolve(dir || process.cwd(), filePath);
      return relative(rootDir, absPath);
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * GLU-221 phase 1 — local git provenance for a project (commit/branch +
 * a GitHub `owner/repo` identity), independent of CI env vars (unlike
 * `detectCiContext` in `ci.ts`, which only reads git-adjacent info when a
 * known CI provider's env vars are present). Used by `sync` to attach
 * provenance to the contract projection so Cloud can eventually deep-link
 * a contract's `sourceFile`/`line` to its GitHub source (phase 2).
 */
export interface GitProvenance {
  /** `"owner/repo"`, parsed from the `origin` remote URL. GitHub only (see
   * `parseGitHubRepo`) — a GitLab/Bitbucket/self-hosted remote yields no
   * provenance at all (fails closed to `null` below), not a wrong value. */
  repo: string;
  /** Full commit SHA (`git rev-parse HEAD`). */
  commit: string;
  /** Current branch name, or `null` on a detached HEAD (a real, common
   * state — most CI checkouts land here — not an error). */
  branch: string | null;
}

/**
 * Parse a `git remote get-url origin` value into a GitHub `"owner/repo"`
 * identity. Recognizes the three common forms (SSH shorthand, `ssh://`,
 * `https://`/`http://`, with or without a trailing `.git`). Returns `null`
 * for anything else — a non-GitHub host (GitLab/Bitbucket/self-hosted),
 * a malformed URL, or a path that doesn't resolve to exactly `owner/repo`.
 * Never throws.
 */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;
  const patterns = [
    // git@github.com:owner/repo(.git)?
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    // ssh://git@github.com/owner/repo(.git)?
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    // https://[user@]github.com/owner/repo(.git)?
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const m = url.match(pattern);
    if (m && m[1] && m[2]) return `${m[1]}/${m[2]}`;
  }
  return null;
}

/**
 * Detect local git provenance for `dir` (default: process cwd). ALWAYS
 * fails closed to `null` — never throws, never emits a partially-guessed
 * value for a boundary case:
 *
 *  - not a git repo at all → `null`
 *  - a repo with zero commits (`rev-parse HEAD` fails) → `null`
 *  - no `origin` remote configured → `null` (commit/branch alone aren't
 *    enough to anchor a Cloud deep link without a repo identity)
 *  - `origin` is a non-GitHub host (GitLab/Bitbucket/self-hosted), or the
 *    URL doesn't parse to `owner/repo` → `null` (see `parseGitHubRepo`)
 *  - detached HEAD → NOT null; `branch` is `null` inside an otherwise
 *    valid result (`rev-parse --abbrev-ref HEAD` prints the literal string
 *    "HEAD", which would be a fabricated branch name if passed through)
 *  - a shallow clone → no special-cased failure; `rev-parse HEAD` and
 *    `remote get-url origin` both work normally on a shallow checkout
 */
export async function detectGitProvenance(dir?: string): Promise<GitProvenance | null> {
  try {
    if (!(await isGitRepo(dir))) return null;

    const commitRes = await execGit(["rev-parse", "HEAD"], dir);
    if (commitRes.code !== 0) return null;
    const commit = commitRes.stdout.trim();
    if (!commit) return null;

    const remoteRes = await execGit(["remote", "get-url", "origin"], dir);
    if (remoteRes.code !== 0) return null;
    const repo = parseGitHubRepo(remoteRes.stdout.trim());
    if (!repo) return null;

    const branchRes = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    const branchRaw = branchRes.code === 0 ? branchRes.stdout.trim() : "";
    const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;

    return { repo, commit, branch };
  } catch {
    return null;
  }
}
