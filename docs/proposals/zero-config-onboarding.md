# Proposal: Zero-Config Onboarding

**Status**: Discussion\
**Date**: 2026-02-20

## Problem

The current minimal onboarding (`glubean init --minimal`) generates 9 files. But Deno supports running `.ts` files
directly without any config. A user should be able to experience Glubean with a single file copy — no `init`, no
`deno.json`, no `.env`.

## Observation

`deno run file.ts` works without `deno.json`. If a test file uses a hardcoded JSR import
(`import { test } from "jsr:@glubean/sdk@^0.11.0"`), it can run standalone.

However, the current architecture strongly discourages hardcoded JSR imports because:

1. **Module-instance split** — the scanner subprocess uses the import map alias. If the test file uses a different
   import path, Deno may resolve two separate module instances, breaking features like trace grouping.
2. **No `.env`** — `ctx.vars.require("BASE_URL")` has nowhere to read from unless the user passes env vars manually.
3. **No `deno task`** — users must type `deno run -A jsr:@glubean/cli run file.ts` every time.

## Ideas to Explore

### 1. `glubean try` — run a built-in demo, zero files generated

```bash
glubean try
# Runs a built-in demo test against dummyjson.com, prints results
# Shows "To create your own tests, run: glubean init"
```

### 2. `glubean init` → single-file mode

Only generate `deno.json` + one explore file. No `.env`, `.gitignore`, or README. The test file hardcodes a demo URL so
it works immediately.

### 3. Auto-init on first `glubean run`

```bash
glubean run explore.test.ts
# No deno.json found — auto-generate minimal config?
# Or: detect missing import map and warn with actionable fix
```

### 4. Support hardcoded JSR imports without module-instance split

If the scanner/runner could handle both import-map and hardcoded imports resolving to the same module instance, the
single-file zero-config story becomes viable. This may require changes to how the SDK registry works.

## Trade-offs

| Approach                 | Files Generated | Import Safety      | User Effort | Complexity |
| ------------------------ | --------------- | ------------------ | ----------- | ---------- |
| Current `init --minimal` | 9               | Safe (import map)  | Medium      | Low        |
| `glubean try`            | 0               | N/A (built-in)     | Lowest      | Low        |
| Single-file init         | 2               | Safe (import map)  | Low         | Low        |
| Auto-init on run         | 0→2             | Safe (auto-gen)    | Lowest      | Medium     |
| Fix module split         | 1               | Safe (either path) | Lowest      | High       |

## Hard Constraint: `deno.json` Is Required

The runner spawns a subprocess that imports `@glubean/sdk/internal` via bare specifier. Without a `deno.json` providing
an import map, this fails:

```
error: Import "@glubean/sdk/internal" not a dependency
```

This means **true zero-config (no `deno.json`) is not currently possible**. Any approach must either:

- Generate a `deno.json` (explicit or auto-generated)
- Or inject `--import-map` into the subprocess Deno invocation

### VSCode Discovery Is Independent

The VSCode extension discovers tests by file name (`*.test.ts`) + content pattern (`import ... from "@glubean/sdk"`). It
does **not** require `deno.json`. So the play button appears even without config — but clicking it will fail at runtime
without the import map.

## Open Questions

- What's the ideal "time to first test run" we're targeting?
- Should `glubean try` be a thing, or is it better to always generate files so the user has something to edit?
- Can we make the scanner handle both import paths without module-instance split?
- Should minimal mode be even more minimal (just `deno.json` + 1 file)?
- Can the runner auto-inject an import map when `deno.json` is missing, so `glubean run file.ts` works standalone?
