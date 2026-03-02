# Proposal: MCP Testing — Protocol & Agent Behavior

**Status**: Discussion\
**Date**: 2026-02-25\
**Updated**: 2026-02-26

## Problem

MCP servers have **two correctness surfaces** that need automated regression coverage:

### 1. Protocol correctness

The server must respond correctly to MCP protocol operations (`initialize`, `tools/list`, `tools/call`, error handling).
This is analogous to API contract testing — if `callTool("ping", {})` returns the wrong shape, nothing works.

Glubean has its own MCP server (`@glubean/mcp`) and needs reliable regression tests beyond ad-hoc manual checks. Current
tooling can run Glubean tests well, but MCP adds complexity: multiple transports, session lifecycle, and sandbox
permissions.

### 2. Tool routing correctness (AI behavior regression)

An MCP server's tool descriptions and parameter schemas are effectively **prompts written for LLMs**. When an AI agent
decides which tool to call for a given user request, it relies on these descriptions. This creates a fragile contract
that breaks silently when:

- **A new model is released** — GPT-5, Claude 4.5, or Gemini updates may interpret the same tool descriptions
  differently, routing prompts to wrong tools or skipping tools entirely.
- **Tool descriptions change** — Rewording a description (even synonyms) can shift model preferences.
- **Tools are added or removed** — A new tool with overlapping description may "steal" calls from existing tools.
- **Parameter schemas change** — Altered required fields may cause models to skip the tool or pass wrong arguments.
- **Provider-side system prompt changes** — Even with no local changes, AI providers can update internal tool-calling
  behavior.

Today there is no automated way to detect these regressions. Teams discover them when users report "the AI stopped using
my MCP tool" — after the damage is done.

## Goal

Ship MCP testing in Glubean across two layers:

1. **Protocol layer**: Verify the MCP server works correctly at the protocol level (Phase 1)
2. **Agent behavior layer**: Verify that AI models route prompts to the correct tools (Phase 2)

Both layers should be:

- Useful for Glubean's own MCP package immediately
- Reusable by anyone testing their own MCP servers
- Safe for cloud execution defaults
- Compatible with the existing SDK plugin architecture

## Non-Goals

1. Full MCP conformance-suite parity
2. Visual protocol timeline UI
3. Auto-generation of tests from server schemas
4. Replacing model evaluation benchmarks (we test tool routing, not general model quality)

---

## Phase 1: Protocol Testing (MVP)

### Product Decision

MVP supports **remote MCP over HTTP/Streamable HTTP only** (server is started by user or CI service).

`stdio` transport is deferred to Phase 3 because it requires `--allow-run` and process lifecycle management.

### Why This Slice

1. Avoids immediate `--allow-run` dependency
2. Fits current cloud-safe defaults better
3. Covers the most CI-friendly setup (service already running)
4. Lets us validate demand before building heavy transport/runtime machinery

### API Shape

Use SDK plugin architecture (`configure({ plugins })`) with a new plugin package: `@glubean/mcp-test`.

```ts
import { configure, test } from "@glubean/sdk";
import { mcp } from "@glubean/mcp-test";

const { mcpClient } = configure({
  plugins: {
    mcpClient: mcp({
      transport: "http",
      baseUrl: "{{MCP_BASE_URL}}",
      timeoutMs: 10_000,
    }),
  },
});

export const listTools = test("mcp-list-tools", async (ctx) => {
  const tools = await mcpClient.listTools();
  ctx.expect(tools.length).toBeGreaterThan(0).orFail("Server should expose at least one tool");
});

export const callPing = test("mcp-call-ping", async (ctx) => {
  const result = await mcpClient.callTool("ping", { message: "hello" });
  ctx.expect(result.isError).toBe(false);
});
```

### Capability Set

1. `initialize` handshake (automatically on first call)
2. `listTools()`
3. `callTool(name, args)`
4. Structured protocol error surface (invalid response, timeout, tool-not-found)
5. Optional request/response tracing as Glubean test events

### Execution and Permissions

**Self-hosted / Local:** HTTP MCP testing works with existing network permission controls (`allowNet`).

**Cloud worker:** Keep default sandbox posture strict:

1. No subprocess spawning requirement
2. No extra permissions beyond network policy already required for outbound calls
3. Continue redaction and network guardrails unchanged

### Internal Design

1. Add new package `packages/mcp-test` (plugin only, no runner changes)
2. Build a small typed MCP client wrapper inside the package
3. Map MCP failures to Glubean assertion-friendly error objects/messages
4. Reuse existing SDK plugin lazy initialization pattern
5. Unit tests for client behavior + integration test against `packages/mcp` test server fixture

### Test Plan

1. `listTools` succeeds and returns at least one tool
2. `callTool` success path
3. `callTool` unknown tool returns deterministic error shape
4. Request timeout surfaces clear diagnostic
5. Server-side protocol error is captured with enough context for AI-assisted fixing

### Release Plan

1. Ship as experimental package (`@glubean/mcp-test`)
2. Add a short guide in `docs/guides/mcp.md` with one end-to-end example
3. Use it internally to test `@glubean/mcp` in CI before wider promotion

### Success Criteria (4-6 weeks)

1. Glubean MCP regressions are caught by automated tests before release
2. At least one external user project adopts the plugin for MCP regression testing
3. No cloud security relaxation required for MVP rollout

---

## Phase 2: Agent Tool Routing Regression

### Problem Statement

Protocol tests verify "the tool works when called." But who verifies "the AI will call the right tool"?

MCP tool descriptions are prompts. When a model is upgraded, tool descriptions change, or new tools are added, AI
routing behavior can silently drift. This is the **MCP equivalent of prompt regression** — and it is the #1 concern for
MCP server maintainers shipping to production.

### Core Testing Model

Given a list of prompts, verify each one triggers the expected set of tool calls:

```
Prompt → LLM + MCP Tools → [tool_call_1, tool_call_2, ...] → Assert tool names ⊇ expected set
```

The key insight: **assert on what the AI does (which tools it calls), not what it says (text output).** Tool routing is
far more deterministic than text generation — the same prompt with reasonable tool descriptions will consistently
trigger the same tools across runs, even if the final text response varies.

### API Shape

Separate plugin package (working name: `@glubean/mcp-agent-test`) that composes with `@glubean/mcp-test` and any AI SDK.
The reference implementation uses Vercel AI SDK (`ai`), but the plugin interface should be provider-agnostic.

```ts
import { configure, test } from "@glubean/sdk";
import { mcpAgent } from "@glubean/mcp-agent-test";

const { agent } = configure({
  vars: { mcpUrl: "MCP_SERVER_URL" },
  secrets: { apiKey: "OPENAI_API_KEY" },
  plugins: {
    agent: mcpAgent({
      transport: "http",
      baseUrl: "MCP_SERVER_URL",
      model: "openai:gpt-4o-mini",
    }),
  },
});

export const toolRouting = test.each([
  {
    prompt: "List all test files in the project",
    expectedTools: ["glubean_list_test_files"],
  },
  {
    prompt: "Run the health check test and show results",
    expectedTools: ["glubean_list_test_files", "glubean_run_local_file"],
  },
  {
    prompt: "What's wrong with my project setup?",
    expectedTools: ["glubean_diagnose_config"],
  },
])("tool-routing-$prompt", async (ctx, { prompt, expectedTools }) => {
  const result = await agent.run(prompt);
  const calledTools = result.toolCalls.map((tc) => tc.toolName);

  for (const tool of expectedTools) {
    ctx.expect(calledTools).toContain(tool)
      .orFail(`Prompt "${prompt}" should trigger ${tool}`);
  }

  ctx.log(`Expected: [${expectedTools.join(", ")}]`);
  ctx.log(`Actual:   [${calledTools.join(", ")}]`);
});
```

### Data-Driven Test Matrix (YAML)

Prompt-to-tool mappings should be maintainable by non-engineers (product, QA):

```yaml
# data/mcp-routing.yaml
- prompt: "List all test files"
  tools: ["glubean_list_test_files"]
- prompt: "Run health check and show results"
  tools: ["glubean_list_test_files", "glubean_run_local_file"]
- prompt: "Diagnose my project"
  tools: ["glubean_diagnose_config"]
```

```ts
import { fromYaml, test } from "@glubean/sdk";

interface RoutingCase {
  prompt: string;
  tools: string[];
}

export const toolRouting = test.each(
  fromYaml<RoutingCase>("./data/mcp-routing.yaml"),
)("mcp-routing-$prompt", async (ctx, { prompt, tools }) => {
  const result = await agent.run(prompt);
  const called = result.toolCalls.map((tc) => tc.toolName);
  for (const t of tools) {
    ctx.expect(called).toContain(t);
  }
});
```

### Assertion Strategies

Tests should support both strict and loose matching:

```ts
// Superset (loose): these tools must be called, extra calls allowed
for (const tool of expectedTools) {
  ctx.expect(calledTools).toContain(tool);
}

// Exact (strict): must call exactly these tools, no more
ctx.expect(new Set(calledTools)).toEqual(new Set(expectedTools));

// Exclusion: must NOT call certain tools
ctx.expect(calledTools).not.toContain("glubean_run_local_file");
```

### Multi-Model Matrix

The same routing cases can be run across models to detect model-specific regressions:

```ts
const models = ["openai:gpt-4o-mini", "openai:gpt-4o", "anthropic:claude-sonnet"];

for (const model of models) {
  export const routing = test.each(cases)(
    `routing-${model}-$prompt`,
    async (ctx, { prompt, expectedTools }) => {
      const result = await agent.run(prompt, { model });
      // ...assertions...
    },
  );
}
```

This produces a prompt × model regression matrix, catching cases where a model upgrade breaks routing for specific
prompts.

### Execution Considerations

| Dimension       | Guidance                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **Cost**        | Use smallest viable model (`gpt-4o-mini`); routing decisions rarely need frontier models          |
| **Timeout**     | Set `meta({ timeout: 60_000 })` — multi-step LLM calls are slower than direct HTTP                |
| **CI strategy** | Tag with `["mcp-agent"]`; run only when MCP server or tool descriptions change, not every commit  |
| **Flakiness**   | If a prompt intermittently routes incorrectly, tighten the prompt wording before adding retries   |
| **Tracing**     | Record each tool call as a Glubean event; on failure, the trace shows the full AI reasoning chain |

### Permissions

Same as Phase 1 — outbound HTTP only. The plugin calls the LLM API (e.g., OpenAI) and the MCP server, both over HTTP. No
additional sandbox permissions required.

### Internal Design

1. Add `packages/mcp-agent-test` as a separate plugin package
2. Depend on `@glubean/mcp-test` for MCP client functionality
3. Reference implementation wraps Vercel AI SDK (`ai` + `@ai-sdk/openai`)
4. Plugin interface is provider-agnostic: accept any `generateText`-compatible function
5. Return structured result: `{ text, toolCalls, toolResults, steps }`

### Success Criteria (4-6 weeks after Phase 1)

1. Glubean MCP tool routing is regression-tested across at least 2 models
2. Routing test matrix catches at least one real regression (tool description or model change)
3. At least one external MCP server project adopts the tool routing test pattern
4. Non-engineer team members can add routing cases via YAML without code changes

---

## Phase 3: stdio Transport & Transport Matrix

Add `stdio` transport support with explicit permission model:

1. Local/self-hosted: opt-in `--allow-run`
2. Cloud: default disabled unless dedicated isolated worker profile is introduced
3. Transport matrix mode: run the same protocol test cases across `http` and `stdio`
4. Agent routing tests should also support stdio-backed MCP servers transparently

---

## Package Structure

| Package                   | Layer                   | Dependencies                              | Phase |
| ------------------------- | ----------------------- | ----------------------------------------- | ----- |
| `@glubean/mcp-test`       | Protocol testing        | `@modelcontextprotocol/sdk`               | 1     |
| `@glubean/mcp-agent-test` | Tool routing regression | `@glubean/mcp-test`, `ai` (Vercel AI SDK) | 2     |

Both are SDK plugins (`definePlugin()`). No runner changes required in any phase.

## Open Questions

1. Should Phase 1 target Streamable HTTP only, or include SSE from day one?
2. Do we want built-in assertion helpers (`toHaveTool`, `toReturnText`) in Phase 1 or leave assertions generic?
3. Should we store protocol transcripts as artifacts in `.glubean/` for diff-based regression?
4. Should `@glubean/mcp-agent-test` be an official package or start as a cookbook recipe to validate demand first?
5. For multi-model matrix testing, should we provide a built-in model rotation helper or let users compose with
   `test.each()` manually?
6. How do we handle cost attribution for LLM-based routing tests in the cloud runner billing model?
