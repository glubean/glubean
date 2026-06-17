# engine browser-safety guardrail

`@glubean/engine` is the **shared** run-loop core: the Node host (`@glubean/runner`)
and lite's BrowserHost both reference it. So the engine must stay
**browser-bundleable and browser-functional** — no node-only code may leak into
it. As we migrate harness features into the engine, this guardrail catches a leak
the moment it happens, instead of discovering it (and having to strip it out) at
the end.

Two gates, run after every migration step:

## Gate 1 — build-gate (cheap, every step, no browser)

```
pnpm --filter @glubean/engine smoke        # tsc build + esbuild browser bundle + leak check
```

Bundles the engine (browser target) and **fails if any node-only builtin leaks**
into the core. Allowed builtins (shimmed, never called on the browser path) are
listed in `build-smoke.mjs`; anything else fails the build. Also prints the
bundle size and the node builtins pulled in — a new entry or a size jump is a
tripwire to investigate.

## Gate 2 — real-Chrome run (deeper, per migrated feature)

```
pnpm --filter @glubean/engine smoke:serve  # build-gate, then serve on :8930
```

Then drive a real Chrome (chrome-devtools MCP) at `http://localhost:8930`, wait
for `window.__GLUBEAN_SMOKE.done`, and assert `window.__GLUBEAN_SMOKE.ok === true`
with no console errors. This proves the engine actually *runs* in a browser:
`resolve()` + `run()`, assertions pass/fail, and **real ky 2 does a real fetch**
(GET + POST/json + trace) against the same-origin `/api/echo` endpoint (no CORS).

## The migration loop

For each harness feature moved into the engine (steps → branch → poll → retry →
workflow → contract → session), add one representative test to `smoke-entry.mjs`,
then require all three to be green before moving on:

1. `pnpm --filter @glubean/engine smoke`  — build-gate (no node leak)
2. `pnpm --filter @glubean/runner test`   — node behavior unchanged
3. Gate 2 real-Chrome smoke               — the feature runs in a browser

## Files

- `smoke-entry.mjs` — the in-browser smoke (grows one test per migrated feature)
- `build-smoke.mjs` — esbuild build-gate + node-builtin leak detector (`buildSmoke()`)
- `serve-smoke.mjs` — builds, then serves the page + same-origin echo API
- `shim-async-hooks.js`, `shim-empty.cjs` — browser shims (mirror lite's bundle)
- `dist-smoke/` — build output (git-ignored)
