# Glubean VS Code Extension — Development Status & Next Steps

## Current State (as of 2026-02-13)

The extension is **functional and installed in Cursor**. Tests are discovered, play buttons appear in gutter, and execution works with structured output in the Test Results panel.

### What's Done

1. **Test Discovery** (`src/parser.ts`)

   - Static regex parser that extracts `test()`, `test.each()`, `test.pick()` from TypeScript files
   - `isGlubeanFile()` checks for `@glubean/sdk` imports (supports `jsr:@glubean/sdk@version` with version suffixes)
   - Returns `TestMeta[]` with `id`, `name`, `line`, `tags`, `steps`

2. **Test Controller** (`src/testController.ts`)

   - Uses `vscode.TestController` API for native gutter play buttons & Test Explorer sidebar
   - File watchers auto-refresh tests on save
   - Execution via `child_process.spawn` calling `glubean run`
   - Always passes `--verbose --pretty --result-json --emit-full-trace` for maximum output
   - Streams stdout/stderr **live** into `TestRun.appendOutput()` (Test Results panel)
   - Parses `.result.json` for structured results (pass/fail/skip per test, assertions, errors)
   - Rich event formatting: logs, assertions, HTTP traces, metrics, schema validation, step boundaries
   - Debug profile with `--inspect-brk` and V8 Inspector polling

3. **Extension Entry** (`src/extension.ts`)

   - Activates test controller, registers commands
   - **One-click setup**: auto-installs Deno + CLI with progress notification
   - Context-aware setup prompts (different messages for missing Deno vs missing CLI)
   - "Learn more" button opens bundled `docs/setup.md` explainer
   - Cross-platform: curl/wget fallback (Linux), PowerShell bypass (Windows)
   - `denoPath()` resolves `~/.deno/bin/deno` as fallback when not on PATH
   - Renamed command: "Glubean: Setup" (was "Check Dependencies")

4. **Environment Switcher**

   - Status bar item showing selected `.env` file
   - QuickPick command `glubean.selectEnv` to switch environments
   - Wired into CLI via `--env-file` flag
   - Persisted in workspace state

5. **Trace Files**

   - CLI generates `.glubean/traces/{filename}/{timestamp}.trace.jsonc` on each run
   - JSONC format with `{request, response}` pairs
   - Auto-opens latest trace in side editor after execution
   - Auto-cleanup keeps last 20 traces per file

6. **Directory-Based Test Organization**

   - `tests/` directory → permanent tests (CI, Cloud) → "Tests" group in Test Explorer
   - `explore/` directory → exploratory tests (IDE iteration) → "Explore" group in Test Explorer
   - All test files use `*.test.ts` suffix (directory determines grouping, not file suffix)
   - CLI `glubean run` defaults to `testDir` config; `glubean run --explore` uses `exploreDir`

7. **Quality-of-Life**

   - **Re-run last request** (`Cmd+Shift+R` / `Ctrl+Shift+R`): re-invokes the last test run
   - **Diff with previous run**: compares latest two trace files using native VSCode diff
   - **Variable hover preview**: shows resolved `.env` values when hovering over `vars.require("KEY")` or `secrets.require("KEY")` (secrets are masked)
   - **Copy as cURL**: converts trace requests to cURL commands in clipboard
   - **CodeLens for `test.pick`**: inline buttons for each example key

8. **Build & Package**

   - esbuild bundler → `dist/extension.js` (~28.5KB)
   - `npm run package` produces `glubean-0.1.0.vsix`
   - `docs/setup.md` bundled in VSIX

9. **Tests** (`src/parser.test.ts`)
   - Unit tests for parser: `isGlubeanFile`, all test patterns, JSR versioned imports
   - Run with: `npx tsx --test src/parser.test.ts` (from `packages/vscode/`)

---

## Done: Emit HTTP Request/Response Bodies in Trace Events (`--emit-full-trace`)

### Implementation (completed)

Added `--emit-full-trace` CLI flag that flows through the full pipeline:

1. **CLI** (`mod.ts`) — new `--emit-full-trace` option on the `run` command
2. **CLI** (`commands/run.ts`) — `RunOptions.emitFullTrace` passed to `TestExecutor`
3. **Executor** (`executor.ts`) — `ExecutorOptions.emitFullTrace` forwarded as `--emitFullTrace` CLI arg to harness subprocess
4. **Harness** (`harness.ts`) — when enabled:
   - `beforeRequest` hook captures request body from ky options (`options.json` / `options.body`)
   - `afterResponse` hook uses `response.clone()` to read response body without consuming the original stream (no conflict with ky `.json()`)
   - Emits enriched `ApiTrace` with `requestHeaders`, `requestBody`, `responseHeaders`, `responseBody`
   - 10KB size guard via `truncateBody()` to prevent huge bodies bloating the event stream
5. **VS Code Extension** (`testController.ts`) — always passes `--emit-full-trace` for maximum output

### Key design decision: `response.clone()` approach

Uses `response.clone()` in the `afterResponse` hook to read the body on a clone, leaving the original response stream intact for ky's `.json()` / `.text()` calls. The `afterResponse` hook is `async` (ky awaits the returned Promise). This avoids the timing split of a two-phase trace and keeps the protocol simple.

---

## File Reference

| File                                    | Purpose                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `packages/vscode/package.json`          | Extension manifest (metadata, config, commands, scripts)   |
| `packages/vscode/src/extension.ts`      | Entry point: activates controller, registers commands      |
| `packages/vscode/src/testController.ts` | TestController: discovery, execution, result display       |
| `packages/vscode/src/parser.ts`         | Static regex parser for test files                         |
| `packages/vscode/src/parser.test.ts`    | Parser unit tests                                          |
| `packages/vscode/tsconfig.json`         | TypeScript config                                          |
| `packages/vscode/.vscodeignore`         | Package exclusions                                         |
| `packages/vscode/.vscode/launch.json`   | Debug launch config                                        |
| `packages/vscode/.vscode/tasks.json`    | Build task config                                          |
| `packages/runner/harness.ts`            | **Needs fix**: enrich auto-trace with headers/body         |
| `packages/sdk/types.ts:956`             | `ApiTrace` interface (already has all fields)              |
| `packages/cli/commands/run.ts`          | CLI `glubean run` (pipeline already passes events through) |

---

## Roadmap: API Explorer Mode

The extension already works as a test runner. The next evolution is to position it as an **API Explorer** — a code-first replacement for Postman/REST Client, where SDK files double as interactive request collections.

### Design decisions

- **No custom viewer.** No Webview, no Preact, no React. Use Monaco (VSCode's native editor) for everything — JSON highlighting, folding, search are free.
- **No in-memory history.** File system is the history store. `.glubean/traces/` directory, gitignored, with automatic cleanup.
- **No custom diff UI.** VSCode native diff (`Select for Compare`, `vscode.diff` API) is better than anything we'd build.
- **Directory is the semantic boundary.** `tests/` vs `explore/`. All test files use `*.test.ts` suffix. CLI has `--explore` flag and `testDir`/`exploreDir` config.

> **Convention change (2026-02-13):** Originally used file suffixes (`*.explore.ts` vs `*.test.ts`) to distinguish explore from test files. Now uses directory structure (`explore/` vs `tests/`) with a unified `*.test.ts` suffix. This simplifies tooling and aligns with the `glubean init` scaffold.

---

### Phase 1: Trace file infrastructure ✅ DONE

**Goal:** Every run produces a human-readable `.trace.jsonc` file with `{request, response}` pairs. This is the foundation for all Explorer features.

#### 1a. `.trace.jsonc` file format

Each trace file is a JSONC array of request/response pairs:

```jsonc
// products.explore.ts — 2 HTTP calls
// Run at: 2026-02-11T15:30:00Z
// Environment: dev

[
  {
    "request": {
      "method": "GET",
      "url": "https://dummyjson.com/products?limit=5",
      "headers": { "accept": "application/json" }
    },
    "response": {
      "status": 200,
      "statusText": "OK",
      "durationMs": 42,
      "headers": { "content-type": "application/json; charset=utf-8" },
      "body": {
        "products": [],
        "total": 194
      }
    }
  }
]
```

**Why this format:**

- `{request, response}` pairs — matches Postman/REST Client mental model
- JSONC — supports comments for metadata (file name, timestamp, environment)
- Array — naturally handles multi-step tests with multiple HTTP calls
- Monaco gives folding, search, syntax highlighting for free

#### 1b. `.glubean/traces/` directory structure

```
.glubean/
└── traces/
    ├── products.explore/
    │   ├── 2026-02-11T1530.trace.jsonc
    │   └── 2026-02-11T1532.trace.jsonc
    └── auth.test/
        └── 2026-02-11T1545.trace.jsonc
```

- Subdirectory per source file (name = filename without `.ts`)
- Files named by ISO timestamp (minute precision)
- Auto-cleanup: CLI deletes files beyond the most recent N (e.g. 20) per subdirectory
- `.glubean/` added to `.gitignore` by `glubean init` (and documented)

#### 1c. CLI generates trace files

**Where:** `packages/cli/commands/run.ts`, after writing `.result.json`

- Extract `type === "trace"` events from collected run events
- Reshape into `{request, response}` pairs
- Write to `.glubean/traces/{name}/{timestamp}.trace.jsonc`
- Print clickable path in CLI output
- Always generate when `--emit-full-trace` is active (which extension always passes)

**Relationship to `.result.json`:**

| File           | Audience                             | Content                                  | Retention                |
| -------------- | ------------------------------------ | ---------------------------------------- | ------------------------ |
| `.result.json` | Programs (extension, web viewer, CI) | Full run: summary + tests + all events   | Latest only (overwrite)  |
| `.trace.jsonc` | Humans (developer in IDE / terminal) | HTTP pairs only, per-call, with comments | Timestamped, last N kept |

**Touches:** `packages/cli/commands/run.ts`

---

### Phase 2: Explore convention ✅ DONE (revised: directory-based)

> **Note:** Original design used `*.explore.ts` suffix. Revised to directory-based convention:
> `explore/` for exploration, `tests/` for permanent tests. All files use `*.test.ts`.

#### 2a. Directory semantics

- `explore/*.test.ts` — for API exploration (try endpoints, inspect responses)
- `tests/*.test.ts` — for automated testing (assertions, CI, pass/fail)
- Both use the same SDK (`import { test } from "@glubean/sdk"`)
- Directory determines Test Explorer grouping, not file suffix

#### 2b. CLI behavior

- `glubean run` (no args): scans `**/*.test.ts`, **skips** `*.explore.ts`
- `glubean run explore/products.explore.ts`: runs the specified file (explicit path always works)
- No `glubean explore` subcommand

**Touches:** `packages/cli/commands/run.ts` (glob/filter logic)

#### 2c. VSCode extension behavior

- File watcher: `**/*.test.ts` AND `**/*.explore.ts` — **both discovered**
- Both get gutter ▶ play buttons and Test Explorer entries
- Test Explorer groups them with distinct icons or separate root nodes (e.g. "Tests" vs "Explore")
- Running an explore file auto-opens the latest `.trace.jsonc` in `ViewColumn.Beside`

**Touches:** `testController.ts` (watcher glob, post-run file open), `parser.ts` (recognize `*.explore.ts`)

#### 2d. Configuration in `deno.json`

```jsonc
{
  "glubean": {
    "tracesPath": ".glubean/traces" // default, configurable
  }
}
```

`explorePath` is a convention (put explore files in `explore/`), not a config — since suffix is the real discriminator.

---

### Phase 3: Environment switcher ✅ DONE

#### 3a. Status bar picker

- Status bar item: `"env: dev"` (bottom bar)
- Click → QuickPick listing detected `.env.*` files in project root
- Detects: `.env`, `.env.dev`, `.env.staging`, `.env.prod`, etc.
- Selection stored in `workspaceState`

#### 3b. Wire into execution

- `buildArgs()` appends `--env-file .env.staging` based on current selection
- Applies to both test and explore runs

**Touches:** `extension.ts` (status bar), `testController.ts` (`buildArgs`), `package.json` (contributes status bar)

---

### Phase 4: Quality-of-life ✅ DONE

#### 4a. Re-run Last Request

- Track last executed TestItem
- Command: `glubean.rerunLast` with keybinding (`Cmd+Shift+R`)
- Command palette: "Glubean: Re-run Last Request"

**Touches:** `testController.ts`, `extension.ts`, `package.json`

#### 4b. Diff with Previous Run

- Command: `glubean.diffPrevious`
- Reads `.glubean/traces/{name}/` directory, picks latest two files
- Calls `vscode.commands.executeCommand('vscode.diff', uri1, uri2, title)`
- Native Monaco side-by-side diff — change highlighting, folding, navigation

**Touches:** `extension.ts` (command registration), `testController.ts` (or new utility)

#### 4c. Variable Hover Preview

- `HoverProvider` for `*.test.ts` / `*.explore.ts`
- On hover over string in `vars.require("KEY")`, show resolved value from current `.env` file
- Respects active environment from status bar picker

**Touches:** New `hoverProvider.ts`, `extension.ts`

#### 4d. Copy as cURL

- Generate cURL from trace data (method, url, headers, body)
- Available as command after execution, or from context menu on trace files

**Touches:** `testController.ts` or utility module

---

## Implementation Plan (historical reference)

> These were the original implementation plans. All 4 phases are now **complete**.
> Kept for reference — implementation may have diverged from these notes in some details.

### Phase 1: Trace file infrastructure

#### Step 1.1 — CLI: write `.trace.jsonc` files

**File:** `packages/cli/commands/run.ts`

After the existing `.result.json` write block (~line 1258), add a new block:

1. For each test in `collectedRuns`, extract events where `type === "trace"`
2. Reshape each trace event's `.data` into `{ request: { method, url, headers, body }, response: { status, statusText, durationMs, headers, body } }`
3. Group by test file. For each file:
   - Compute subdirectory name: `basename(file).replace(/\.ts$/, "")` → e.g. `products.explore`
   - Compute timestamp: `new Date().toISOString().replace(/[:.]/g, "").slice(0, 13)` → e.g. `2026-02-11T1530`
   - Target path: `{rootDir}/.glubean/traces/{subdir}/{timestamp}.trace.jsonc`
   - `await Deno.mkdir(dir, { recursive: true })`
   - Build JSONC content: comment header (filename, timestamp, env file used) + JSON.stringify(pairs, null, 2)
   - Write file
   - Print clickable path: `console.log(\`Trace: ${tracePath}\`)`
4. Auto-cleanup: after writing, read dir entries, sort by name descending, delete anything beyond index 20

**Condition:** Always generate when `--emit-full-trace` is active (which is always true from the extension, and opt-in from CLI).

**Test:** Run `glubean run demo.test.ts --emit-full-trace` → verify `.glubean/traces/demo.test/{timestamp}.trace.jsonc` is created with correct structure.

#### Step 1.2 — VSCode: auto-open trace file after run

**File:** `packages/vscode/src/testController.ts`

In `runFile()` and `runSingleTest()`, after `applyResults()`:

1. Determine the trace subdirectory: `.glubean/traces/{basename}/`
2. Read dir, sort by name descending, pick the first (latest) `.trace.jsonc`
3. Open it:
   ```typescript
   const doc = await vscode.workspace.openTextDocument(traceUri);
   await vscode.window.showTextDocument(doc, {
     viewColumn: vscode.ViewColumn.Beside,
     preview: true,
     preserveFocus: true, // keep focus on test file
   });
   ```
4. Use `preserveFocus: true` so the user's cursor stays in their test/explore file

**Test:** Run a test via ▶ → trace file opens in side panel with formatted JSON.

---

### Phase 2: Directory-based explore convention (REVISED)

> **Revised from suffix-based (`*.explore.ts`) to directory-based (`explore/` vs `tests/`).**

#### Step 2.1 — CLI: directory-aware scanning

**File:** `packages/cli/commands/run.ts`

- `glubean run` defaults to `testDir` (usually `tests/`)
- `glubean run --explore` uses `exploreDir` (usually `explore/`)
- Explicit path (`glubean run path/to/file.test.ts`) always works regardless of directory

#### Step 2.2 — VSCode: discover files from both directories

**File:** `packages/vscode/src/testController.ts`

- File watchers for `**/*.test.ts` cover both directories
- `discoverAllTests()` finds all `*.test.ts` files in workspace
- Files under `explore/` or `exploreDir` config go under "Explore" root node
- Files under `tests/` or `testDir` config go under "Tests" root node

Tree structure:

```
Glubean Tests
├── Tests
│   ├── products.test.ts
│   └── auth.test.ts
└── Explore
    └── check-auth.test.ts
```

---

### Phase 3: Environment switcher

#### Step 3.1 — Status bar item

**File:** `packages/vscode/src/extension.ts`

1. Create status bar item in `activate()`:
   ```typescript
   const envStatusBar = vscode.window.createStatusBarItem(
     vscode.StatusBarAlignment.Right,
     100
   );
   envStatusBar.command = "glubean.selectEnv";
   envStatusBar.tooltip = "Glubean: Select environment";
   context.subscriptions.push(envStatusBar);
   ```
2. Initialize: read `workspaceState.get("glubean.envFile", ".env")`, update text to `"env: dev"` (derive display name from filename)
3. Register command `glubean.selectEnv`:
   - Glob for `.env*` in workspace root (exclude `.env.secrets`, `.env.*.local`)
   - Show `vscode.window.showQuickPick(items)`
   - On select: save to `workspaceState`, update status bar text

**File:** `packages/vscode/package.json`

4. Add command contribution for `glubean.selectEnv`

#### Step 3.2 — Wire env into buildArgs

**File:** `packages/vscode/src/testController.ts`

1. Export a getter: `getSelectedEnvFile(): string | undefined`
2. In `buildArgs()`: if env file is set and not `.env`, append `--env-file <value>`
3. The CLI already supports `--env-file` — no CLI changes needed

---

### Phase 4: Quality-of-life

#### Step 4.1 — Re-run last request

**Files:** `testController.ts`, `extension.ts`, `package.json`

1. In `testController.ts`: store last run `{ filePath, testId }` after each execution
2. In `extension.ts`: register `glubean.rerunLast` command that re-invokes the run handler with the stored item
3. In `package.json`: add keybinding `Cmd+Shift+R` → `glubean.rerunLast`

#### Step 4.2 — Diff with previous run

**Files:** `extension.ts`, `package.json`

1. Register `glubean.diffPrevious` command
2. Implementation: read `.glubean/traces/{name}/` for the current file, sort entries, pick latest two, call `vscode.commands.executeCommand('vscode.diff', ...)`
3. If only one trace exists, show info message "No previous run to compare with"

#### Step 4.3 — Variable hover

**Files:** new `src/hoverProvider.ts`, `extension.ts`

1. Register `HoverProvider` for `typescript` language
2. On hover: check if cursor is inside `vars.require("...")` or `secrets.require("...")`
3. Parse the string literal to get the variable name
4. Read the active `.env` file (from status bar selection), find the value
5. Return `new vscode.Hover(\`**${key}** = \`${value}\`\`)`

#### Step 4.4 — Copy as cURL

**Files:** `extension.ts` or utility module

1. Register `glubean.copyAsCurl` command
2. Reads the active `.trace.jsonc` document, parses the JSON
3. For each (or selected) request/response pair, generates cURL:
   ```
   curl -X POST 'https://...' \
     -H 'content-type: application/json' \
     -d '{"username":"emilys"}'
   ```
4. Copies to clipboard via `vscode.env.clipboard.writeText()`

---

## Execution Status

All 4 phases are **complete**:

1. ~~Phase 1 (trace files)~~ ✅
2. ~~Phase 2 (explore convention)~~ ✅ — revised from suffix-based to directory-based
3. ~~Phase 3 (env switcher)~~ ✅
4. ~~Phase 4 (QoL)~~ ✅

**Additional completed (2026-02-13):**
- One-click setup (auto-install Deno + CLI)
- Bundled setup.md with "Learn more" flow
- Debug profile with `--inspect-brk`
- CodeLens for `test.pick` examples
- Cross-platform support (macOS, Linux, Windows)

---

## Build & Install Commands

```bash
# From packages/vscode/
npm run lint          # TypeScript type check
npm run build         # esbuild bundle
npm run package       # Create .vsix
# Install in Cursor:
#   Cmd+Shift+P → "Extensions: Install from VSIX..." → select .vsix file
```
