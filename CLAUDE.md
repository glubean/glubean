# Glubean OSS (Node.js) — Project Rules

> **Workspace-level rules: see [`../internal/CLAUDE.md`](../internal/CLAUDE.md)** (read first if you haven't this session).

## Repo Structure
- Monorepo with pnpm workspaces
- Packages (14 published): **core** — sdk, engine, scanner, redaction, runner, cli · **clients** — cloud-client · **plugins** — auth, browser, graphql, grpc, mcp, oauth-code · **meta** — `glubean` (the `npx glubean` CLI). Intra-repo deps are all `workspace:*`.
- Publish workflow triggers on git tags matching `v*`

## Version Policy

### Lockstep — every package shares ONE version (owner 2026-06-18)
ALL 14 published packages (core + clients + plugins + `glubean` meta) carry the **same version** and
are bumped **together** on every release — even packages that didn't change. Currently `0.10.3`.

- **Why lockstep (not per-package semver):** these are one product split into modules with
  hard internal coupling — e.g. the runner's workflow executor imports `@glubean/sdk/internal`,
  so a runner/sdk version skew crashes at runtime. The version means "this SET is compatible."
  Same model as Babel / Angular / Jest. **This supersedes the old minor-aligned / patch-independent
  / plugins-independent rule** (which was the bookkeeping the owner moved away from).
- **Never touch intra-repo dependency ranges.** They stay `workspace:*`; `pnpm publish` rewrites
  them to the exact current version at publish time. You only edit the `version` field — to the
  **same value in every package.json**.
- Republishing an unchanged package (new number, identical content) is expected and ~free — fine.

### Release cadence
- **Batch releases.** Accumulate commits on main, then bump + tag + publish as ONE release.
  Do NOT bump/tag/publish per commit. Urgent bugfix → ask the owner before an off-cadence release.

### How to release `vX.Y.Z`
1. Bump **every** publishable `version` to the same X.Y.Z (test-project is not published — skip it):
   ```
   node -e 'const fs=require("fs"),p=require("path");for(const d of fs.readdirSync("packages")){const f=p.join("packages",d,"package.json");if(fs.existsSync(f))fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/("version":\s*")[^"]+(")/,"$1X.Y.Z$2"))}'
   ```
2. `pnpm install` (lockfile stays clean for a pure version bump) → `CI=1 pnpm -r build` → **`CI=1 pnpm -r test`**.
   - **Run the FULL `pnpm -r test`, never a scoped subset.** A change to a shared shape (e.g. the
     workflow wrapper, an `@glubean/sdk/internal` export) has monorepo-wide blast radius that
     per-package gates miss (this bit us at the v0.7.0 release — graphql/grpc tests broke).
   - **Prefix with `CI=1`** (matching the actual CI env) so `cli`/`mcp`'s `pretest` guard (see
     Commit gate below) no-ops instead of doing a redundant, racy nested rebuild during `pnpm -r test`.
3. `git commit -m "chore(release): vX.Y.Z"` → `git tag vX.Y.Z` → push the commit **and** the tag.

### Release mechanics / gotchas
- **Publish is tag-gated.** Pushing to `main` does NOT publish; only pushing a `v*` tag fires
  `publish.yml` (which runs `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test`, then
  publishes in dependency order).
- **The `NPM_TOKEN` secret must be publish-capable.** It must be a current token with WRITE access
  to the `@glubean` scope. A stale/read-only token publishes nothing and npm reports `E404` on the
  PUT (npm hides scope existence behind 404, not 401/403). **Symptom: CI build+test pass but every
  publish step E404s** → rotate the GitHub Actions `NPM_TOKEN` secret.
- **`continue-on-error: true` on the publish steps HIDES publish failures** — the job shows green
  even when nothing published. ALWAYS verify after a release: `npm view @glubean/sdk version`.
  (Consider removing the continue-on-error so publish failures go red.)
- Never publish an existing version — npm rejects it (`cannot publish over the previously published
  versions: X.Y.Z`). Always bump first.

## Publish Order (dependency chain)
sdk → engine → scanner → redaction → runner → cli → glubean, then auth, browser, graphql,
cloud-client → mcp, grpc, oauth-code.

engine depends on sdk; runner on engine/sdk/scanner; cli on sdk/runner/scanner/redaction; glubean
(meta) on cli; mcp on cloud-client/runner/scanner/sdk; the other plugins on sdk. The CI workflow
encodes this order — keep `publish.yml` and this list in sync when packages are added/removed.

## Branch Policy — issues-driven OSS workflow (owner 2026-07-18)

This repo has real external users; development follows the public open-source
workflow. Full runbook: `~/glubean/automation/development/core-oss-workflow.md`.

- **Issue-first**: features / fixes / refactors start as an English GitHub
  issue (labeled), then `<type>/<slug>` branch → PR with `Fixes #N` → CI green
  + codex converge gate → **squash merge**.
- **Direct commits to main** are allowed only for: typos, docs-only changes,
  lint/format, and release version-bump commits.
- **Agent autonomy (this repo only)**: agents may create issues, push
  branches, open PRs, and squash-merge once the converge gate is clean.
  npm releases (tags) stay owner-gated.
- **Public surface language: English.** Issues, PRs, commit messages, release
  notes, and all in-repo docs are English-only.
- Issue hygiene: first response to external issues ≤48h; close fixed issues at
  release time with the version number; no zombie issues.

## Commit gate

See [`~/.claude/CLAUDE.md`](/Users/peisong/.claude/CLAUDE.md) (global) for the converge gate + propose-skip categories. This repo follows the global rule unchanged. Test runner here is `vitest` (per-package).

**Scoped `pnpm --filter <pkg> test` before `pnpm -r build`** can read a workspace dependency's
stale `dist/` (gitignored, not rebuilt) through the symlink and produce a false-red result that
looks like a real bug (bit us twice on `@glubean/redaction` — GLU-194/GLU-198 were both stale-dist
false alarms, not real defects). `cli` and `mcp` now carry a `pretest: "test -n \"$CI\" || pnpm
--filter \"@glubean/<pkg>...\" build"` guard: it rebuilds only that package's own dependency
closure (not the whole workspace), and only outside `CI` — under `CI=true` it's a no-op, since the
release/publish flow already runs `pnpm -r build` before `pnpm -r test` (skipping it there avoids
two packages' pretest hooks doing a concurrent, non-incremental `tsc` rebuild of shared deps like
`sdk`/`redaction` mid-`pnpm -r test`, which is wasted work at best and a `dist/` write race at
worst — reproduced locally before this guard was added). **When running the full pre-release
`pnpm -r build && pnpm -r test` locally (not through CI), prefix it with `CI=1`** so the same
no-op guard kicks in and you get the same race-free behavior as the CI pipeline. For any other
package, run `pnpm -r build` once before a scoped test run, or don't trust a red result without
checking whether the failing package's dist actually matches its src (GLU-200).

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

### Lifecycle discipline (owner-accepted GPT-pro feedback, 2026-06-13)

**`setup`/`teardown` do ENVIRONMENT PREPARATION only** (provision a receiver,
mint a client, seed credentials, clean up the same). Any business interaction
— creating an order, calling an API under test, flipping a feature flag that
the scenario asserts on — MUST be a `call`/`action` node. Lifecycle phases
have no grade and project only presence + note: business behavior hidden in
setup is an agreement the projection cannot see. Same migration note as above.

Two more authoring rules from the same review:

- **`workflow.each` row data enters state via the setup closure ONLY** — never
  into predicate operands (`predicate.x.eq(row.y)` makes rows project different
  structures and is rejected at build time). Assert against state with
  `eqPath`, or use row-invariant operands.
- **`switch`/`route` `on` lenses must be pure selectors** (`(state) =>
  state.field`). Classification logic (ternaries, comparisons) goes in an
  explicit `compute` node first — an expression inside `on` is invisible to
  the projection while the node still grades `full`.
- **`compute` bodies must be PURE** — they are dry-run once at build/scan
  time through a tracing proxy (the mechanism every declared lens shares),
  so closure mutation or side effects execute at authoring time too. State
  in, state out, nothing else; side effects belong in `.action()`.
