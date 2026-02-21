# Glubean OSS — Publish Readiness

**Status: ALMOST READY** — Updated 2026-02-13.

## Completed (since 2026-02-11)

- [x] VS Code extension: one-click setup (auto-install Deno + CLI from extension)
- [x] VS Code extension: bundled setup.md explainer with "Learn more" flow
- [x] VS Code extension: context-aware setup prompts (different messages for missing Deno vs missing CLI)
- [x] VS Code extension: cross-platform support (curl/wget fallback, PowerShell bypass, platform-aware shortcuts)
- [x] CLI: `--explore` flag with `testDir`/`exploreDir` config
- [x] CLI: `glubean run` target is now optional (defaults to testDir)
- [x] CLI: restructured `init` scaffold with `tests/explore/data/context/` directories
- [x] Scanner: only scans `*.test.ts` files (aligned with directory convention)
- [x] VS Code README: updated for directory-based test organization
- [x] Landing page: one-line install (`curl | sh`), reduced from 4 steps to 3
- [x] Landing page: `install.sh` script (auto-detects/installs Deno + CLI)

## Remaining Before Publish

### Blockers

1. **Register Marketplace publisher** — Create `glubean` at https://marketplace.visualstudio.com/manage/createpublisher
2. **Screenshots/GIFs** — Capture from a live session for the Marketplace listing
3. **SDK: Remove `testCase`/`testSuite`** — Legacy APIs still exist in `mod.ts`, `types.ts`, `mod_test.ts`, `data.ts`,
   `data_test.ts`, `README.md`. Must remove before 0.1.0 (see SDK_API_REVIEW.md §1.1)
4. **Rewrite `glubean-tests/api.test.ts`** — Still uses bare `fetch()` (6 instances). Must use `ctx.http` — this is the
   primary example users will copy (see SDK_API_REVIEW.md §3.5)
5. **Push to origin** — 35+ commits ready across repos

### High Priority (should-do for 0.1.0)

6. **Add `retries` to `TestMeta`** — Needed for flaky API endpoints (Medium effort)
7. **Add `ctx.sleep(ms)`** — Simple delay helper (Small effort)

### Nice-to-Have (post-launch)

8. **Homebrew tap** — `glubean/homebrew-tap` with shim formula (`depends_on "deno"`)
9. **GitHub Actions release workflow** — Auto-update Homebrew formula on new CLI tag
10. ~~**Update `TODO.md`**~~ ✅ Updated — historical implementation notes kept with convention change annotations
