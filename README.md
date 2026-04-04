# Glubean

The verification layer between intent and implementation. Write tests in TypeScript, run locally or in CI, let AI agents write and repair them.

[![npm version](https://img.shields.io/npm/v/@glubean/sdk)](https://www.npmjs.com/package/@glubean/sdk)
[![CI](https://github.com/glubean/glubean/actions/workflows/publish.yml/badge.svg)](https://github.com/glubean/glubean/actions/workflows/publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

```bash
npx glubean config mcp        # AI agent can run and inspect tests
npx skills add glubean/skill   # AI agent learns Glubean patterns
```

```text
"write a smoke test for /users"
"migrate our Postman collection"
"design the billing API contracts before I build it"
```

The agent writes the test, runs it via MCP, reads the structured failure, fixes it, and reruns — in one conversation.

## Two ways to use it

**API already exists?** Point the agent at your API. It writes tests that run, break, get repaired, and graduate from `explore/` to `tests/` to CI.

**API doesn't exist yet?** Describe what it should do. The agent writes executable contracts in `contracts/` — the implementation must satisfy them. After you build the API, the same contracts become your regression tests.

## Quick start

```bash
npx glubean init      # interactive wizard: try, test existing API, or contract-first
npx glubean run       # run tests
```

Or with AI:

```bash
npx glubean config mcp
npx skills add glubean/skill
```

Then ask your agent anything — it writes, runs, reads structured failures, and fixes in a loop.

## VS Code extension

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-demo-scratch.gif" alt="Glubean VS Code extension demo" width="800">
</p>

The extension serves two roles:

1. **Postman replacement** — `explore/` is your API collection in code. Click the gutter play button to send a request, see full response in the result viewer. Save parameter sets with `test.pick`, share via git. No Postman account, no per-seat pricing.
2. **Visual layer for test results** — run from gutter or Test Explorer, inspect structured traces, debug with typed `expected` vs `actual`.

Same TypeScript file works as both API collection entry and CI regression test. No export, no conversion.

## Packages

| Package | What it does |
|---------|-------------|
| [@glubean/sdk](packages/sdk) | Author tests — `test()`, `configure()`, assertions, builder flows |
| [@glubean/cli](packages/cli) | Run tests, manage environments, init projects |
| [@glubean/runner](packages/runner) | Test executor engine |
| [@glubean/scanner](packages/scanner) | Static analysis for IDE integration |
| [@glubean/mcp](packages/mcp) | MCP server — agents run and inspect tests |
| [@glubean/redaction](packages/redaction) | Sensitive data redaction |

### Plugins

| Plugin | Protocol |
|--------|----------|
| [@glubean/auth](packages/auth) | Bearer, API key, OAuth |
| [@glubean/browser](packages/browser) | Browser automation (Puppeteer) |
| [@glubean/graphql](packages/graphql) | GraphQL queries and mutations |
| [@glubean/grpc](packages/grpc) | gRPC (coming soon) |

## Links

- [Landing](https://glubean.com) — product overview
- [Docs](https://docs.glubean.com) — full documentation
- [VS Code Extension](https://marketplace.visualstudio.com/items?itemName=glubean.glubean)
- [Cookbook](https://github.com/glubean/cookbook) — working examples
- [Agent Skill](https://github.com/glubean/skill) — teach AI agents Glubean patterns

## License

MIT
