# Changelog

## 0.1.0 — Initial Release

### Features

- **Test Discovery** — Automatically discovers `*.test.ts` files with `@glubean/sdk` imports
- **Inline Play Buttons** — Run individual tests or entire files from gutter icons
- **Test Explorer** — Full integration with VS Code's Test Explorer sidebar, grouped under "Tests" and "Explore" nodes based on directory
- **Live Output** — Streams test execution output in real-time to the Test Results panel
- **Structured Results** — Parses `.result.json` for detailed pass/fail/skip status per test, including assertions, HTTP traces, and errors
- **Trace Files** — Automatically opens `.trace.jsonc` files after execution, showing structured `{request, response}` pairs in the editor
- **Environment Switcher** — Status bar picker to switch between `.env` files (e.g., `.env.staging`, `.env.prod`)
- **Re-run Last Request** — `Cmd+Shift+R` / `Ctrl+Shift+R` to re-run the last executed test
- **Diff with Previous Run** — Compare the latest two trace files using VS Code's native diff viewer
- **Variable Hover Preview** — Hover over `vars.require("KEY")` or `secrets.require("KEY")` to see resolved values from the active `.env` file
- **Copy as cURL** — Convert trace requests to cURL commands in clipboard
- **Debug Support** — Full VS Code debugging with breakpoints via `--inspect-brk`
- **One-Click Setup** — Auto-installs Deno and Glubean CLI with a single click (cross-platform)
- **`test.pick` CodeLens** — Clickable buttons for each named example above `test.pick()` calls
