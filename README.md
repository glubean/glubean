# Glubean

Developer-owned API verification — code-first in TypeScript, accelerated by AI.

[![npm version](https://img.shields.io/npm/v/@glubean/sdk)](https://www.npmjs.com/package/@glubean/sdk)
[![CI](https://github.com/glubean/glubean/actions/workflows/publish.yml/badge.svg)](https://github.com/glubean/glubean/actions/workflows/publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

<p align="center">💬 <a href="https://chatgpt.com/g/g-699e31ce19bc8191b748165f46449039-glubean">Ask Glubean AI anything</a> — setup help, feature questions, comparisons</p>

## What is Glubean?

Glubean lets you write API verification code — not test scripts — that runs locally, in CI, or against production. Multi-step workflows, session state, data-driven scenarios, and plugin composition are all first-class. With plugins, verify browser interactions, GraphQL, gRPC, or anything else Node.js supports. Built for AI agents: MCP server, schema inference, and structured feedback make AI-authored verification a reality today.

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-demo-scratch.gif" alt="Glubean scratch mode demo" width="800">
</p>

## Quick Start

**Scratch mode (zero config):**

```bash
# 1. Create a file
echo 'import { test } from "@glubean/sdk";
export const smoke = test("smoke", async (ctx) => {
  const res = await ctx.http.get("https://dummyjson.com/products/1").json();
  ctx.expect(res.id).toBe(1);
});' > smoke.test.js

# 2. Run it
npx glubean run smoke.test.js
```

**Project mode:**

```bash
npx glubean init
npx glubean run
```

## Packages

| Package | Description |
|---------|-------------|
| [@glubean/sdk](packages/sdk) | Core SDK — test, configure, data loaders |
| [@glubean/cli](packages/cli) | CLI — run, init, upload |
| [@glubean/runner](packages/runner) | Test executor engine |
| [@glubean/scanner](packages/scanner) | Static analysis for IDE integration |
| [@glubean/auth](packages/auth) | Auth plugins — bearer, apiKey, OAuth |
| [@glubean/mcp](packages/mcp) | MCP server for AI tools |
| [@glubean/browser](packages/browser) | Browser automation plugin |
| [Agent Skill](https://github.com/glubean/skill) | AI skill — docs, patterns, test-writing guidance |
| [@glubean/graphql](packages/graphql) | GraphQL plugin |
| [@glubean/grpc](packages/grpc) | gRPC plugin |
| [@glubean/redaction](packages/redaction) | Sensitive data redaction |

## Links

- [Documentation](https://docs.glubean.com)
- [VS Code Extension](https://marketplace.visualstudio.com/items?itemName=glubean.glubean)
- [Cookbook](https://github.com/glubean/cookbook)
- [Issues](https://github.com/glubean/glubean/issues)

## License

MIT
