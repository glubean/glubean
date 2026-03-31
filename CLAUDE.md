# Glubean OSS (Node.js) — Project Rules

## Repo Structure
- Monorepo with pnpm workspaces
- Packages: sdk, scanner, redaction, runner, auth, mcp, graphql, browser, cli
- Publish workflow triggers on git tags matching `v*`

## Version Policy

### Core packages (minor-aligned, patch independent)
sdk, scanner, redaction, runner, cli

- **All core packages share the same minor version** (currently `0.1`). Patch versions are independent — only bump the package(s) you changed.
- Pre-launch: PATCH only (`0.1.x`).
- Bump command (example): `pnpm --filter @glubean/cli exec -- npm version 0.1.X --no-git-tag-version`

### Plugin packages (versioned independently)
auth, browser, graphql, mcp

- Each plugin has its own version. Bump only the plugin you changed.
- Bump command (example): `pnpm --filter @glubean/browser exec -- npm version 0.2.X --no-git-tag-version`

### Release cadence
- **Batch releases every 2-7 days.** Accumulate commits on main, then bump + tag + publish as one release.
- **Do NOT bump/tag/publish after every commit.** Version inflation wastes version numbers and creates noisy changelogs.
- **Exception: urgent bugfixes.** Ask the user before publishing an urgent fix outside the normal cadence.
- When ready to release: bump changed packages → commit → `git tag v0.1.X` → `git push && git push origin v0.1.X`

### Release mechanics
- Never publish a version that already exists on npm. Always bump before tagging.
- CI publishes all packages on tag. Already-published versions are skipped (`continue-on-error`).

## Publish Order (dependency chain)
sdk → scanner → redaction → runner → cli (core), then auth, browser, graphql, mcp (plugins)

The CI workflow handles this automatically. Do not change the order without updating the dependency graph.

## Branch Policy
- Solo development: direct commits to main are OK.
- With collaborators: require branch + PR + squash merge. Add branch protection when the team grows.
