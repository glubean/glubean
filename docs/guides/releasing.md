# Releasing Packages

This guide covers how to safely bump, publish, and coordinate releases across the Glubean monorepo.

## Package Dependency Graph

```
sdk ← scanner ← cli
sdk ← runner  ← cli
```

`cli` is the top-level consumer. Changes to `sdk` or `runner` exports can break `cli` (and therefore every user) if the
downstream package isn't updated and published in the same release.

## Version Bumping Rules

### Patch bumps (auto-published)

The `auto-patch` GitHub Actions workflow watches `packages/*/deno.json`. When a patch-only version bump lands on `main`,
the workflow runs tests and publishes to JSR automatically.

**The golden rule: if you change an export, bump all affected packages in one PR.**

| What changed         | What to bump                                                  |
| -------------------- | ------------------------------------------------------------- |
| SDK types or exports | `sdk` + `scanner` + `cli` (if they import the changed symbol) |
| Runner exports       | `runner` + `cli`                                              |
| Scanner exports      | `scanner` + `cli`                                             |
| CLI internals only   | `cli` only                                                    |

### How to check

```bash
# Example: you added a new export to runner
rg "from.*@glubean/runner" packages/cli/
# If there are matches importing the new symbol → bump cli too
```

### Minor / major bumps (manual)

For breaking changes or new features that warrant a minor/major bump, use the `release.yml` workflow or publish
manually. The `auto-patch` workflow intentionally skips non-patch bumps.

## Step-by-Step Release

### 1. Create a feature branch

```bash
git checkout -b fix/my-change
```

### 2. Make code changes and bump versions

Edit `deno.json` in each affected package. Only change the **patch** digit for auto-publish:

```json
{ "version": "0.11.1" }
```

### 3. Verify locally

```bash
deno check packages/*/mod.ts
deno test -A
deno fmt --check
```

### 4. Open PR and merge

Once CI passes, merge to `main`. The `auto-patch` workflow will:

1. Detect which `deno.json` files changed
2. Run the full test suite
3. Publish each bumped package to JSR

### 5. Verify publication

```bash
curl -s https://jsr.io/@glubean/runner/meta.json | jq .latest
curl -s https://jsr.io/@glubean/cli/meta.json | jq .latest
```

Do **not** update downstream consumers (VSCode extension, user projects) until you confirm the expected versions are
live.

## Cross-Repo Coordination (VSCode Extension)

The VSCode extension lives in a separate repo (`glubean/vscode`) and depends on JSR packages via npm bridges.

**Order matters:**

1. Publish OSS packages first (merge to `main`, wait for auto-publish)
2. Verify JSR versions are live
3. Update `package.json` in the VSCode repo with new dependency versions
4. **Bump the extension's own `version`** — VS Code caches extensions by version; same version = stale code
5. Run `npm install && npm run lint && npm run build`
6. Test locally with `npm run install:vscode`

Cross-reference PRs in both repos for traceability.

## Import Path Rule

Templates and generated test files must use the import map alias, never hardcoded JSR URLs:

```typescript
// ✅ Correct
import { test } from "@glubean/sdk";

// ❌ Wrong — causes module-instance split with the scanner
import { test } from "jsr:@glubean/sdk@^X.Y.Z";
```

**Why:** The scanner's extraction subprocess and the test file must share the same SDK module instance (and therefore
the same internal registry). Hardcoded URLs can resolve to a different module instance, silently breaking features that
depend on the shared registry (e.g., `groupId` for trace grouping).

### How it works

`glubean init` generates a `deno.json` with the import map definition:

```json
{
  "imports": {
    "@glubean/sdk": "jsr:@glubean/sdk@^0.11.0"
  }
}
```

The JSR URL belongs **only** in this import map. All `.test.ts` files and `AGENTS.md` examples must use the alias
`@glubean/sdk`, which Deno resolves through the import map. This guarantees the test code and the scanner subprocess
load the same module instance.

## Template Maintenance

The CLI `init` command (`packages/cli/commands/init.ts`) generates starter projects from template files in
`packages/cli/templates/`. These templates are the first thing new users see, and their content is copied verbatim into
the user's AI context (`AGENTS.md`).

### What to check when releasing

| File                                 | What to verify                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `packages/cli/commands/init.ts`      | SDK version in `makeDenoJson()` matches `packages/cli/deno.json`           |
| `packages/cli/templates/*.test.ts`   | All imports use `@glubean/sdk` alias (never `jsr:` URL)                    |
| `packages/cli/templates/AGENTS.md`   | Code examples use `@glubean/sdk` alias; assertion list matches current SDK |
| `packages/cli/commands/init_test.ts` | Version assertion matches current SDK version                              |

### Why this matters

Templates generated by older CLI versions may contain hardcoded JSR URLs. Users who ran `glubean init` before this
convention was enforced will have test files with `import { test } from "jsr:@glubean/sdk@^0.10.0"` — these will work
for running tests but silently break scanner-dependent features (trace grouping, metadata extraction). If a user reports
such issues, the fix is to change their imports to use the `@glubean/sdk` alias.

## Common Mistakes

| Mistake                                         | Symptom                                   | Fix                               |
| ----------------------------------------------- | ----------------------------------------- | --------------------------------- |
| Bump CLI but not runner                         | `SyntaxError: does not provide an export` | Bump both in the same PR          |
| Change VSCode code without bumping version      | Reinstall shows old behavior              | Bump `version` in `package.json`  |
| Template uses `jsr:@glubean/sdk@^X.Y.Z`         | Scanner features silently break           | Change to `@glubean/sdk` alias    |
| Update VSCode deps before JSR publish completes | `npm install` pulls old version           | Wait and verify with `curl` first |
