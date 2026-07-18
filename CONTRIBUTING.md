# Contributing to Glubean

Thanks for your interest in contributing! This document explains how the
project is developed and what to expect when you open an issue or a pull
request.

## Project status

Glubean is actively developed by a solo maintainer (plus AI agents doing a lot
of the typing). Expect a first response to issues and PRs within about 48
hours. Small, focused contributions are much easier to review and land than
large ones — when in doubt, open an issue first and ask.

## Repository layout

This is a pnpm workspace with 14 published packages under [`packages/`](packages/):

- **core** — `sdk`, `engine`, `scanner`, `redaction`, `runner`, `cli`
- **clients** — `cloud-client`
- **plugins** — `auth`, `browser`, `graphql`, `grpc`, `mcp`, `oauth-code`
- **meta** — `glubean` (the `npx glubean` CLI)

All published packages share **one lockstep version** and are released
together. Intra-repo dependencies are `workspace:*` — never change those
ranges; `pnpm publish` rewrites them at publish time. Releases are cut by the
maintainer via `v*` tags; contributors never need to touch versions.

## Development setup

Requirements: Node.js ≥ 22.19 (all packages declare `engines.node: >=22.19.0`)
and [pnpm](https://pnpm.io) 10.

```bash
pnpm install
CI=1 pnpm -r build
CI=1 pnpm -r test
```

The `CI=1` prefix matters: it disables per-package `pretest` rebuild hooks so
the full-workspace build/test run behaves exactly like the CI pipeline (and
avoids concurrent rebuilds of shared packages). If you run a scoped test for a
single package (`pnpm --filter @glubean/<pkg> test`), run `pnpm -r build`
first — otherwise the test may read a stale `dist/` of a workspace dependency
and fail for the wrong reason.

## Issues first

- **Bug fixes, features, refactors**: please open an issue before writing
  code, so we can agree on the direction. Use the issue templates.
- **Typos and docs-only fixes**: a direct PR is fine.
- Issues about the hosted **Glubean Cloud dashboard** (app.glubean.com) are
  out of scope for this repo — they are tracked internally. Feel free to file
  them anyway; they'll be labeled `cloud` and forwarded.

## Pull requests

1. Fork/branch from `main`, name the branch `<type>/<slug>`
   (e.g. `fix/cli-readiness-race`).
2. Keep the PR focused on one issue; reference it with `Fixes #N`.
3. Make sure `CI=1 pnpm -r build && CI=1 pnpm -r test` passes locally —
   the same commands run in CI on every PR.
4. PRs are squash-merged.

All public communication in this repo (issues, PRs, commits, docs) is in
English.

## Security

Please do **not** report security vulnerabilities in public issues — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache-2.0](LICENSE) license that covers the project.
