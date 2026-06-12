# Glubean OSS (Node.js) — Project Rules

> **Workspace-level rules: see [`../internal/CLAUDE.md`](../internal/CLAUDE.md)** (read first if you haven't this session).

## Repo Structure
- Monorepo with pnpm workspaces
- Packages: sdk, scanner, redaction, runner, auth, mcp, graphql, browser, cli
- Publish workflow triggers on git tags matching `v*`

## Version Policy

### Core packages (minor-aligned, patch independent)
sdk, scanner, redaction, runner, cli

- **All core packages share the same minor version** (currently `0.1`). Patch versions are independent — only bump the package(s) you changed.
- Pre-launch: PATCH only (`0.1.x`) **except** one-off minor jumps for architecture rewrites. v0.1.x → v0.2.0 happens once at the contract-system rewrite (2026-04-18), and is OK because there are no external users.
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

## Commit gate

See [`~/.claude/CLAUDE.md`](/Users/peisong/.claude/CLAUDE.md) (global) for the converge gate + propose-skip categories. This repo follows the global rule unchanged. Test runner here is `vitest` (per-package).

## vNext workflow authoring conventions (owner decision 2026-06-12, "option D")

When writing `workflow()` code anywhere (tests, fixtures, cookbook, dogfood):

1. **A workflow containing branch/poll/switch/route/pollAction goes in a
   `.flow.ts` file**, never a `.test.ts`. (`.flow.ts` is runtime-extracted —
   always precise; `.test.ts` relies on a static AST gate that is a TEMPORARY
   stopgap until Cloud renders branch/poll nodes.)
2. **Inside fragments / each-factories / group bodies, use the builder ONLY in
   direct chains**: `b.x().y()` or `const c = b.x(); return c.y()`.
3. **Never store the builder in objects/arrays, destructure it, or pass it to
   other functions** (the `.use(fragment)` argument is the one sanctioned way
   to hand it off).

Rationale: the `.test.ts` static branch/poll upload gate (scanner
`extractor-ast.ts`) is FROZEN at its S2.13 R19 state by owner decision — do
not extend its adversarial-JS detection further. Codex findings about new
ways to "hide" a builder in test files are answered by these conventions
(upstream prevention), not by new scanner code. The whole gate is deleted
when Cloud branch/poll rendering ships. When vNext is released, migrate these
three rules into the `skill` repo's authoring guidance.

### Hint discipline (phase4 §6.4, owner decision 2026-06-12)

When writing workflows, FILL THE HINT SLOT of every opaque/partial position
you author — `note` on setup/teardown/actions, `asserts` on checks, `message`
on runtime predicates — in the same edit as the implementation, not as a
separate pass. Hints are declarations the projection renders; an agent that
just wrote the code can state what it does at zero cost. (Migrate into the
skill repo at vNext release, together with the three conventions above.)
