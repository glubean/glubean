# AI Developer Experience (AI-DX) Design

This document outlines how Glubean ensures a superior developer experience for users assisted by AI coding agents (Cursor, Copilot, etc.).

## The Challenge: "Cold Start"

When a user opens a new, empty workspace to write a Glubean test, their AI assistant lacks context:
- No local source code (Glubean is a remote dependency).
- No documentation files in the workspace.
- No existing patterns to mimic.

Without intervention, AI agents will hallucinate incorrect APIs (e.g., `console.log` instead of `ctx.log`, or `describe/it` patterns from Jest).

## The Solution: Remote Context Injection

We rely on a multi-layered approach to inject context into the user's AI environment.

### 1. LSP-Based Context (The "JSDoc" Layer)

Deno's architecture allows it to fetch remote dependencies and cache them locally. The Language Server Protocol (LSP) then exposes types and documentation from these cached files to the editor.

**Strategy:**
- **Rich JSDoc:** Every exported interface in `@glubean/sdk` must have extensive JSDoc comments.
- **`@example` Tags:** Use the `@example` tag in JSDoc to show AI exactly how to use an API.

**Example (`packages/sdk/types.ts`):**
```typescript
/**
 * The context passed to every test function.
 * 
 * @example
 * // ✅ Correct: Use ctx.log to capture logs in the runner
 * ctx.log("User logged in", { userId: 123 });
 * 
 * // ❌ Incorrect: console.log will not be captured in the report
 * console.log("User logged in");
 */
export interface TestContext {
  log(message: string, data?: any): void;
}
```

**Effect:** When AI sees `ctx` typed as `TestContext`, it reads the JSDoc and learns to use `ctx.log`.

### 2. Scaffolding (The "Few-Shot" Layer)

AI models perform best when they have examples to mimic (Few-Shot Learning). We must ensure the user's workspace is never truly "empty".

**Strategy:**
- **`glubean init` Command:** This command should generate a `glubean.json` config AND a `examples/hello.test.ts` file.
- **Canonical Example:** The generated test file must showcase all best practices (imports, `testCase`, `ctx.log`, `ctx.assert`).

**Effect:** Cursor/Copilot will index `examples/hello.test.ts` and use it as a template for generating new tests.

### 3. Registry Metadata (The "JSR" Layer)

Publishing to [JSR (JavaScript Registry)](https://jsr.io) provides better metadata than raw HTTPS imports.

**Strategy:**
- Use `jsr:@glubean/sdk` imports.
- JSR automatically generates documentation sites that AI search tools might index.
- JSR provides faster and more reliable type resolution for the editor.

### 4. Explicit Rules (The "Cursor Rules" Layer)

For Cursor users, we can inject specific instructions.

**Strategy:**
- `glubean init` can optionally generate `.cursor/rules/glubean.mdc`.
- **Content:** "Always use `ctx.log`. Import from `@glubean/sdk`. Do not use `console.log`."

## Summary for Contributors

When writing code for `@glubean/sdk` or `@glubean/runner`, remember:

1.  **You are writing for two audiences:** The human developer AND their AI assistant.
2.  **Comments are Code:** JSDoc is not just documentation; it is the "prompt" that guides the AI.
3.  **Examples are Critical:** Provide copy-pasteable examples in comments.
