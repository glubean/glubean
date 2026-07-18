# Glubean OSS (Node.js) — Project Rules

## Repo Structure
- Monorepo with pnpm workspaces
- Packages (14 published): **core** — sdk, engine, scanner, redaction, runner, cli · **clients** — cloud-client · **plugins** — auth, browser, graphql, grpc, mcp, oauth-code · **meta** — `glubean`. Intra-repo deps all `workspace:*`.
- Publish workflow triggers on git tags matching `v*`

## Version Policy — LOCKSTEP
All 14 published packages (core + clients + plugins + the `glubean` meta CLI) share **ONE
version** and are bumped **together** on every release — even packages that didn't change. Intra-repo deps stay `workspace:*`; **never hand-edit version ranges** (`pnpm
publish` rewrites them). Publish is tag-gated (`v*`); pushing to `main` does NOT publish.

> **Canonical policy + release steps + gotchas (NPM_TOKEN must be publish-capable, the
> npm-verify gate, dependency publish order) live in [`CLAUDE.md`](./CLAUDE.md) "Version
> Policy" — read it before releasing.** This LOCKSTEP rule supersedes the older
> minor-aligned / patch-independent / plugins-independent policy.

## Branch Policy — issues-driven OSS workflow (owner 2026-07-18)

Canonical policy lives in [`CLAUDE.md`](./CLAUDE.md) "Branch Policy" — read it
before committing. Summary (CLAUDE.md wins on any conflict):

- **Issue-first**: features / fixes / refactors start as an English GitHub
  issue, then branch → PR (`Fixes #N`) → CI green + review gate → squash merge.
- **Direct commits to main** only for: typos, docs-only changes, lint/format,
  and release version-bump commits.
- **Public surface language: English** (issues, PRs, commits, release notes,
  in-repo docs).
