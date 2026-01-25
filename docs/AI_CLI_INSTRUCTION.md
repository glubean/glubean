# AI Instruction: Generate Glubean CLI Package

You are tasked with implementing the `@glubean/cli` package. This is the developer-facing tool to run tests locally and sync them to the cloud.

## Context
Developers use this CLI to run tests on their machine (using the local Runner) and to deploy their tests to the Glubean registry.

## Requirements

1.  **Tech Stack:** Deno (TypeScript).
2.  **Location:** `packages/cli`
3.  **Dependencies:** Use `@std/cli` or `@cliffy/command` for argument parsing.
4.  **Integration:** Must use `@glubean/runner` to execute tests.

## File Structure

```
packages/cli/
├── deno.json          # Package config (name: "@glubean/cli")
├── mod.ts             # Main entry point (the executable)
└── commands/
    ├── run.ts         # 'glubean run' implementation
    └── sync.ts        # 'glubean sync' implementation (stub for now)
```

## Implementation Details

### 1. `mod.ts`

Setup the CLI command structure using your chosen library.
*   `glubean run <file> [options]`
*   `glubean sync`

### 2. `commands/run.ts`

Implements the local test runner.

**Logic:**
1.  Accept arguments: `file` (path to test file), `--filter` (optional tag/name filter).
2.  **Local Context:** Read `.env` file (if exists) to simulate `$vars` and `$secrets`.
3.  **Discovery:**
    *   Import the target file dynamically: `await import(filePath)`.
    *   Scan exports to find objects matching the `TestCase` interface.
4.  **Execution:**
    *   Instantiate `TestExecutor` from `@glubean/runner`.
    *   Loop through found tests.
    *   Call `executor.run()` for each.
    *   **Pretty Print:** Format the JSON stream from the runner into colorful console output (Green checkmarks for pass, Red X for fail).

### 3. `commands/sync.ts`

Stub this for now. It will eventually handle uploading files to S3.
*   Print "Syncing to Glubean Cloud... (Not implemented yet)".

## Output
Generate the code for `deno.json`, `mod.ts`, `commands/run.ts`, and `commands/sync.ts`. Ensure the `run` command provides good visual feedback.
