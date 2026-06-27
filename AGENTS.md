# Glubean OSS (Node.js) — Project Rules

## Repo Structure
- Monorepo with pnpm workspaces
- Packages (13 published): **core** — sdk, engine, scanner, redaction, runner, cli · **plugins** — auth, browser, graphql, grpc, mcp, oauth-code · **meta** — `glubean`. Intra-repo deps all `workspace:*`.
- Publish workflow triggers on git tags matching `v*`

## Version Policy — LOCKSTEP
All 13 published packages (core + plugins + the `glubean` meta CLI) share **ONE version**
and are bumped **together** on every release — even packages that didn't change (currently
`0.8.1`). Intra-repo deps stay `workspace:*`; **never hand-edit version ranges** (`pnpm
publish` rewrites them). Publish is tag-gated (`v*`); pushing to `main` does NOT publish.

> **Canonical policy + release steps + gotchas (NPM_TOKEN must be publish-capable, the
> npm-verify gate, dependency publish order) live in [`CLAUDE.md`](./CLAUDE.md) "Version
> Policy" — read it before releasing.** This LOCKSTEP rule supersedes the older
> minor-aligned / patch-independent / plugins-independent policy.

## Branch Policy
- Solo development: direct commits to main are OK.
- With collaborators: require branch + PR + squash merge. Add branch protection when the team grows.
