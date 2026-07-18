# Glubean

API quality layer: functional correctness tests and load performance tests in the same TypeScript project, with AI agents that write, run, and repair them.

[![npm version](https://img.shields.io/npm/v/@glubean/sdk)](https://www.npmjs.com/package/@glubean/sdk)
[![CI](https://github.com/glubean/glubean/actions/workflows/publish.yml/badge.svg)](https://github.com/glubean/glubean/actions/workflows/publish.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

```bash
npx glubean config mcp        # AI agent can run and inspect tests
npx skills add glubean/skill   # AI agent learns Glubean patterns
```

```text
"write a smoke test for /users"
"migrate our Postman collection"
"design the billing API contracts before I build it"
"run a load test and show me p95 latency per endpoint"
```

The agent writes the test, runs it via MCP, reads the structured failure, fixes it, and reruns — in one conversation.

## Two ways to use it

**API already exists?** Point the agent at your API. It writes tests that run, break, get repaired, and graduate from `explore/` to `tests/` to CI. Add a load plan alongside to track performance over time.

**API doesn't exist yet?** Describe what it should do. The agent writes executable contracts in `contracts/` — the implementation must satisfy them. After you build the API, the same contracts become your regression tests and can seed load scenarios.

## Quick start

```bash
npx glubean init      # interactive wizard: try, test existing API, or contract-first
npx glubean run       # run tests
npx glubean load      # run load plans (discover *.load.ts, write structured artifacts)
npx glubean login     # authenticate with Glubean Cloud (browser device flow)
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
| [@glubean/sdk/load](packages/sdk) | Author load plans — `loadScenario()`, `loadRunner()`, traffic-mix, feeders |
| [@glubean/cli](packages/cli) | Run tests and load plans, manage environments, init projects |
| [@glubean/engine](packages/engine) | Environment-agnostic run-loop core (Node runner + browser host) |
| [@glubean/runner](packages/runner) | Test and load executor |
| [@glubean/scanner](packages/scanner) | Static analysis for IDE integration |
| [@glubean/mcp](packages/mcp) | MCP server — agents run and inspect tests |
| [@glubean/redaction](packages/redaction) | Sensitive data redaction |

### Plugins

| Plugin | Protocol |
|--------|----------|
| [@glubean/auth](packages/auth) | Bearer, API key, OAuth 2.0 |
| [@glubean/browser](packages/browser) | Browser automation (Puppeteer) |
| [@glubean/graphql](packages/graphql) | GraphQL queries and mutations |
| [@glubean/grpc](packages/grpc) | gRPC unary calls |
| [@glubean/oauth-code](packages/oauth-code) | OAuth Authorization Code flow for explore mode |

## Links

- [Landing](https://glubean.com) — product overview
- [Docs](https://docs.glubean.com) — full documentation
- [VS Code Extension](https://marketplace.visualstudio.com/items?itemName=glubean.glubean)
- [Cookbook](https://github.com/glubean/cookbook) — working examples
- [Agent Skill](https://github.com/glubean/skill) — teach AI agents Glubean patterns

## Contributing

Bug reports, feature requests, and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through
[private vulnerability reporting](SECURITY.md), not public issues.

## License

[Apache-2.0](LICENSE)
