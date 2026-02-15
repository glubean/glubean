# Glubean for VS Code

API collections, as real code — right inside your editor.

Built on top of the [Glubean](https://github.com/glubean/glubean) open-source SDK and CLI. This extension brings the full runtime into VS Code — inline play buttons, auto-traced HTTP output, environment switching, and native diff. No browser tabs, no context switching.

## Features

### Run tests with one click

- **Gutter ▶ play buttons** — click next to any `test()` to run it instantly
- **Test Explorer sidebar** — browse all tests grouped under **Tests** (`tests/`) and **Explore** (`explore/`)
- **Run all in file** — execute every test in the active file from the command palette
- **Re-run last** — `Cmd+Shift+R` / `Ctrl+Shift+R` to instantly re-execute the previous request

### See every request and response

- **Auto-open trace files** — after each run, a `.trace.jsonc` file opens with structured `{request, response}` pairs
- **Full HTTP detail** — method, URL, headers, body, status code, and duration for every traced call
- **Copy as cURL** — convert any traced request to a cURL command (copied to clipboard)

### Compare runs

- **Diff with previous** — open VS Code's native side-by-side diff between your two most recent traces
- **File-based history** — traces are saved under `.glubean/traces/` (auto-cleaned, gitignored), so you can diff any two manually

### Switch environments

- **Status bar switcher** — click the env indicator in the status bar to switch between `.env`, `.env.staging`, `.env.prod`, etc.
- **Secrets follow automatically** — selecting `.env.staging` loads `.env.staging.secrets` for credentials
- **Hover preview** — hover over `vars.require("KEY")` or `secrets.require("KEY")` in your code to see the resolved value (secrets are masked)

### Debug with breakpoints

- **Full debugger support** — set breakpoints in your test code and step through API calls
- **VS Code debug adapter** — uses Deno's V8 inspector with `--inspect-brk`
- **Variable inspection** — inspect request/response data at any point during execution

### Multi-step tests

- **Step visibility** — builder-style tests (`test("id").step(...)`) show each step as a child node in Test Explorer
- **Per-step output** — pass/fail status and logs are attached to individual steps
- **Data-driven tests** — `test.each()` patterns are detected and shown as expandable groups

### Example-driven tests with `test.pick`

Run the same test logic against different example payloads — without polluting your test code with inline data.

**How it works:**

1. Define examples as a named map (inline or from a JSON/YAML file)
2. `test.pick` randomly selects one example at runtime (lightweight fuzz coverage)
3. Click a specific example name in the CodeLens to run it deterministically

```typescript
// Inline examples — great for a few cases
export const createUser = test.pick({
  normal: { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
  admin: { name: "Admin", role: "admin" },
})("create-user-$_pick", async (ctx, example) => {
  await ctx.http.post("/api/users", { json: example });
});
```

```typescript
// JSON file — better for large or shared datasets
import examples from "./data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, example) => {
    await ctx.http.post("/api/users", { json: example });
  },
);
```

**Why external data files?**

- **Clean test code** — your `.test.ts` stays focused on logic; payloads live in `.json` or `.yaml` files
- **Shareable across tests** — multiple test files can import the same data source
- **Git-friendly** — data files have clean diffs; reviewers can see exactly which examples changed. Resetting to a known state is just `git checkout data/`
- **Non-developers can contribute** — QA or product can add test cases by editing JSON/YAML without touching TypeScript

**VS Code integration:**

- **CodeLens buttons** — each example key gets a clickable `▶ normal`, `▶ admin`, etc. above the `test.pick` call
- **CLI override** — `glubean run file.ts --pick admin` runs a specific example
- **Random by default** — without `--pick`, one random example is selected each run

![CodeLens buttons for test.pick examples](docs/codelens-pick.png)

## Getting Started

Just install the extension and open a Glubean project. If Deno or the CLI aren't installed yet, the extension offers **one-click setup** — it installs everything silently in the background (~30 seconds).

You can also install the CLI manually:

```bash
# macOS / Linux
curl -fsSL https://glubean.com/install.sh | sh

# Or with Deno
deno install -Agf jsr:@glubean/cli
```

Then scaffold a project with `glubean init`.

## File Conventions

All Glubean test files must be named `*.test.ts`. The extension uses **directory structure** to organize tests in the sidebar:

| Directory         | Purpose                                            | Test Explorer group |
| ----------------- | -------------------------------------------------- | ------------------- |
| `explore/`        | Interactive API exploration (primary IDE workflow) | **Explore**         |
| `tests/`          | Permanent verification tests (CI / Cloud)          | **Tests**           |
| Other directories | Any `*.test.ts` with SDK import                    | **Tests**           |

Move a file from `explore/` to `tests/` when you're ready to promote an exploration to a permanent test — zero code changes needed.

The default directories are configured in `deno.json`:

```json
{
  "glubean": {
    "run": {
      "testDir": "./tests",
      "exploreDir": "./explore"
    }
  }
}
```

## Commands

| Command                             | Keybinding    | Description                                             |
| ----------------------------------- | ------------- | ------------------------------------------------------- |
| Glubean: Run All Tests in File      | —             | Run all tests in the active `.test.ts` file             |
| Glubean: Run All Tests in Workspace | —             | Run all tests in the workspace                          |
| Glubean: Select Environment         | —             | Open quick pick to choose `.env` file                   |
| Glubean: Re-run Last Request        | `Cmd+Shift+R` | Re-run the most recently executed test(s)               |
| Glubean: Diff with Previous Run     | —             | Side-by-side diff of two most recent traces             |
| Glubean: Copy as cURL               | —             | Copy HTTP requests from the open `.trace.jsonc` as cURL |
| Glubean: Open Last Result JSON      | —             | Open the most recent `.result.json` in a side editor    |
| Glubean: Setup                      | —             | Install or verify Deno and Glubean CLI                  |

## Settings

| Setting                | Default     | Description                                          |
| ---------------------- | ----------- | ---------------------------------------------------- |
| `glubean.glubeanPath`  | `"glubean"` | Path to the Glubean CLI executable                   |
| `glubean.envFile`      | `".env"`    | Default `.env` file (relative to workspace root)     |
| `glubean.verbose`      | `false`     | Pass `--verbose` flag when running tests             |
| `glubean.autoDiscover` | `true`      | Auto-discover tests when files are opened or changed |

## How It Works

1. **Discovery** — The extension scans `*.test.ts` files for `test()`, `test.each()`, and `test.pick()` patterns using static regex analysis. No runtime, no AST parser. Files are grouped by directory: `explore/` goes to the Explore group, everything else to Tests.

2. **Display** — Each test gets a `TestItem` in VS Code's Test Controller, which renders ▶ buttons in the gutter and entries in the Test Explorer sidebar.

3. **Execution** — Clicking ▶ runs `glubean run <file> --filter <test-id> --verbose --result-json --emit-full-trace` via the CLI.

4. **Traces** — The CLI writes `.trace.jsonc` files to `.glubean/traces/`. The extension auto-opens the latest trace in a side editor.

5. **Results** — The extension reads `.result.json` and maps outcomes back to test items, displaying ✓/✗ icons and populating the Test Results panel.

## Supported Test Patterns

```typescript
// Simple test with object metadata
export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke"] },
  async (ctx) => {
    /* ... */
  },
);

// Builder-style multi-step test
export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {
    /* ... */
  })
  .step("get profile", async (ctx, state) => {
    /* ... */
  });

// Data-driven test
export const tests = test.each(data)("case-$id", async (ctx, row) => {
  /* ... */
});

// Example-driven test (random pick + CodeLens per example)
export const createUser = test.pick({
  normal: { name: "Alice" },
  admin: { name: "Admin", role: "admin" },
})("create-user-$_pick", async (ctx, example) => {
  /* ... */
});

// Example-driven test with external data (JSON/YAML)
import examples from "./data/create-user.json" with { type: "json" };
export const createUser2 = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, example) => {
    /* ... */
  },
);

```

## Development

```bash
cd packages/vscode
npm install
npm run watch    # esbuild watch mode

# Then press F5 in VS Code to launch Extension Development Host
```

### Building

```bash
npm run build      # production build
npm run package    # create .vsix
```

### Project Structure

```
src/
├── extension.ts        # Entry point — setup, commands, env switcher, hover provider
├── testController.ts   # Test Controller — discovery, execution, traces, debug
├── hoverProvider.ts    # Hover preview for vars.require() / secrets.require()
├── parser.ts           # Static regex parser — extracts test metadata from source
└── parser.test.ts      # Parser unit tests
docs/
└── setup.md            # Setup explainer (bundled in VSIX, opened via "Learn more")
```

## License

MIT
