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
  /** Full commit SHA (`git rev-parse HEAD`), or `null` when the working tree
   * has uncommitted changes (GLU-221 phase 1 P1 fix). `sync` uploads the
   * CURRENT ON-DISK content, not the HEAD commit's content — reporting a
   * commit here while the tree is dirty would let a consumer (Cloud, phase 2)
   * build a source deep link against a commit whose tree does NOT match what
   * was actually uploaded (wrong line, or a since-changed/deleted one).
   * `repo`/`branch` are still safe to report even when `commit` is `null` —
   * neither claims a byte-for-byte match with one specific commit's tree. */
  commit: string | null;
  /** Current branch name, or `null` on a detached HEAD (a real, common
   * state — most CI checkouts land here — not an error). */
  branch: string | null;
}

/**
 * `owner/repo` from a URL PATH (or the path portion of the SCP shorthand),
 * never from the raw remote string — the caller has already separated any
 * query string / fragment / userinfo out (via `URL` parsing, or the SCP
 * regex's `[^?#]+` exclusion below) before this runs, so neither can leak
 * into the returned repo id. `null` unless the path is EXACTLY two
 * non-empty segments (fewer/more, e.g. a nested group path, isn't a GitHub
 * `owner/repo` and would be a guess).
 */
function normalizeOwnerRepoPath(path: string): string | null {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const withoutGit = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
  const segments = withoutGit.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * Parse a `git remote get-url origin` value into a GitHub `"owner/repo"`
 * identity. Recognizes the three common forms (SSH shorthand, `ssh://`,
 * `https://`/`http://`, with or without a trailing `.git`). Returns `null`
 * for anything else — a non-GitHub host (GitLab/Bitbucket/self-hosted),
 * a malformed URL, or a path that doesn't resolve to exactly `owner/repo`.
 * Never throws.
 *
 * GLU-221 phase 1 P2-1 fix — the previous implementation matched the
 * `https?://` form with a single non-greedy regex all the way to end-of-
 * string. A remote URL carrying a query string (`https://github.com/acme/
 * app.git?token=xxx`, e.g. a credential-in-URL origin) has no `/` after the
 * `.git`, so the non-greedy group backtracked to swallow `.git?token=xxx`
 * whole into the "repo" capture — leaking the token into the parsed repo id
 * (which then ships to the server as `git.repo`). Real URL forms (`ssh://`,
 * `https://`/`http://`) are now parsed with the `URL` constructor, which
 * separates `search`/`hash`/userinfo from `pathname` per spec — only
 * `pathname` ever reaches `normalizeOwnerRepoPath`. The SCP shorthand
 * (`git@github.com:owner/repo`, not a real URL `URL` can parse) keeps a
 * regex but now explicitly excludes `?`/`#` from the captured path.
 */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;

  const scpMatch = url.match(/^git@github\.com:([^?#]+)$/);
  if (scpMatch) return normalizeOwnerRepoPath(scpMatch[1]!);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ssh:" && parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  // ssh:// form requires the literal `git@` user, same as the old regex —
  // an ssh:// origin with no/different user isn't the shorthand this
  // recognizes.
  if (parsed.protocol === "ssh:" && parsed.username !== "git") return null;
  return normalizeOwnerRepoPath(parsed.pathname);
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
 *  - an uncommitted change anywhere in the working tree → `commit` is
 *    `null` (see `GitProvenance.commit`); everything else in the result is
 *    unaffected
 */
export async function detectGitProvenance(dir?: string): Promise<GitProvenance | null> {
  try {
    if (!(await isGitRepo(dir))) return null;

    const commitRes = await execGit(["rev-parse", "HEAD"], dir);
    if (commitRes.code !== 0) return null;
    const commitSha = commitRes.stdout.trim();
    if (!commitSha) return null;

    const remoteRes = await execGit(["remote", "get-url", "origin"], dir);
    if (remoteRes.code !== 0) return null;
    const repo = parseGitHubRepo(remoteRes.stdout.trim());
    if (!repo) return null;

    const branchRes = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    const branchRaw = branchRes.code === 0 ? branchRes.stdout.trim() : "";
    const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;

    // GLU-221 phase 1 P1 fix — `sync` uploads the CURRENT WORKING TREE, which
    // can differ from HEAD's tree (uncommitted edits). Reporting `commitSha`
    // unconditionally would let a consumer build a source deep link that
    // points at the WRONG snapshot — the safest thing a `git status
    // --porcelain` failure (can't confirm clean) OR a non-empty result
    // (confirmed dirty) can do is withhold the precise commit, never guess.
    const dirty = await isWorkingTreeDirty(dir);
    const commit = dirty ? null : commitSha;

    return { repo, commit, branch };
  } catch {
    return null;
  }
}

/**
 * `true` when the working tree has any uncommitted change (`git status
 * --porcelain` is non-empty) — staged, unstaged, or untracked. Fails
 * CLOSED to `true` ("assume dirty") on a `git status` failure: withholding
 * a precise commit-based deep link is always safe; fabricating one from an
 * unconfirmed-clean tree is not.
 *
 * `--untracked-files=all` is EXPLICIT, not left to config: `git status`
 * otherwise honors the repo/user `status.showUntrackedFiles` setting, which
 * large repos commonly set to `no` for speed. With `no`, an untracked file
 * emits no `??` line, so a tree carrying an untracked (but scanned) contract
 * source would look clean here — and we'd hand back HEAD's commit for a deep
 * link into a tree that doesn't contain that file. Forcing `all` makes the
 * dirtiness check independent of any ambient config.
 */
async function isWorkingTreeDirty(dir?: string): Promise<boolean> {
  const { code, stdout } = await execGit(["status", "--porcelain", "--untracked-files=all"], dir);
  if (code !== 0) return true;
  return stdout.trim().length > 0;
}
