# Glubean OSS Agent Guidelines

This document provides instructions for AI agents (Cursor, Copilot, etc.) working on the Glubean OSS codebase.

## Codebase Context

Glubean OSS is a Deno-based monorepo containing the core runner technology.

- **Runtime:** Deno (TypeScript)
- **Package Manager:** None (Deno uses URLs/JSR)
- **Workspace:** `packages/sdk`, `packages/runner`, `packages/cli`, `packages/scanner`, `packages/redaction`,
  `packages/mcp`, `packages/worker`
- **VSCode Extension:** `packages/vscode` (Node.js + esbuild)

## AI-Friendly Coding Standards

When writing code in `packages/sdk`, you must follow these rules to ensure the code is consumable by _other_ AI agents
used by our end-users.

### 1. JSDoc as AI Prompts

Treat JSDoc comments as prompts for the end-user's AI.

- **MUST** add JSDoc to all exported interfaces and functions.
- **MUST** use `@example` tags to demonstrate correct usage.
- **MUST** explain _why_ an API exists, not just what it does (e.g., "Use `ctx.log` instead of `console.log` to ensure
  persistence").

**Bad:**

```typescript
interface TestContext {
  log(msg: string): void;
}
```

**Good:**

```typescript
/**
 * The context passed to every test function.
 *
 * @example
 * ctx.log("User created", { id: 123 });
 */
export interface TestContext {
  /**
   * Logs a message to the runner's output stream.
   * These logs are persisted and visible in the Glubean dashboard.
   */
  log(message: string, data?: unknown): void;
}
```

### 2. Type Definitions

- **Prefer Interfaces:** Use `interface` over `type` for public APIs where possible, as they are often better handled by
  documentation tools.
- **Explicit Returns:** Always declare return types explicitly to help LSP and AI inference.

### 3. Scaffolding Context

`glubean init` generates a sample test file and config. This serves as few-shot context for the user's AI assistant —
ensure the generated test showcases all SDK best practices (imports, `test()`, `ctx.log`, `ctx.assert`,
`ctx.vars.require`).

### 4. Registry Metadata

Publishing to JSR (`jsr:@glubean/sdk`) provides better type resolution and documentation than raw URL imports. Always
use JSR imports in examples and documentation.

### 5. No Magic Globals

- Do not rely on global variables (like `window` or `globalThis`) unless absolutely necessary.
- Everything should be passed via the `ctx` (TestContext) object. This helps AI understand the boundaries of the test
  environment.

## Template Maintenance

The CLI `init` command (`packages/cli/commands/init.ts`) generates starter projects from templates in
`packages/cli/templates/`. These templates are the first thing users see, so they must stay current.

**When bumping versions or changing conventions, always check:**

- `packages/cli/commands/init.ts` — SDK version in `makeDenoJson()` and `PLAYGROUND_DENO_JSON` (e.g.
  `jsr:@glubean/sdk@^0.10.0`)
- `packages/cli/templates/*.test.ts` — import paths, API usage, assertion methods must reflect the current SDK
- `packages/cli/templates/AGENTS.md` — the assertion method list and API examples must match the current SDK surface
- `packages/cli/commands/init_test.ts` — version assertion in the test that verifies generated `deno.json`

Common gotchas:

- **Import paths**: Templates that land in `tests/` must use `../data/...` to reach the `data/` directory at project
  root (not `./data/...`)
- **`fromCsv` / `fromYaml` paths**: These are CWD-relative (resolved via `Deno.readTextFile`), so `./data/...` is
  correct — unlike `import` statements which are file-relative

## Documentation

- **Markdown:** All documentation in `docs/` should be clear, concise, and structured.
- **English:** All comments and documentation must be in English.

## Git Workflow — Strict GitHub Flow

This repository follows **GitHub Flow**. No exceptions.

### Rules

1. **Never commit directly to `main`.** All changes — no matter how small — must go through a pull request.
2. **Create a feature branch** for every unit of work:
   - Branch from `main`
   - Use descriptive names: `feat/add-polling-api`, `fix/scanner-timeout`, `docs/update-agents`
3. **Open a Pull Request** before merging. PRs must:
   - Have a clear title and description
   - Pass CI checks
   - Receive at least one approval (when reviewers are available)
4. **Merge via PR only.** Use squash-merge or merge commit per team preference — never push directly to `main`.
5. **Delete the branch** after merging.

### For AI Agents

- **Ask for explicit permission before every git operation.** This includes:
  - Creating a branch (`git checkout -b`)
  - Committing (`git commit`)
  - Pushing (`git push`)
  - Creating a PR (`gh pr create`)
- Never perform any of these operations silently or automatically. Always describe what you intend to do and wait for a clear "yes" or equivalent confirmation.
- **Never run `git push` to `main`** — push to the feature branch and open a PR.

## Testing

- We use Deno's built-in test runner for our own tests: `deno test`.
- When generating tests for the `cli` or `runner`, ensure they mock external dependencies appropriately.
