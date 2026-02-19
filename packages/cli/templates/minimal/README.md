# Glubean — Minimal Explore Project

A quick-start project for exploring APIs with [Glubean](https://glubean.com). Write TypeScript, click play, see every
request and response.

## Quick start

```bash
deno task explore
```

Open `explore/api.test.ts` for basic GET/POST examples, or `explore/search.test.ts` for parameterized search with
`test.pick`.

## What's here

| Path                        | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `explore/api.test.ts`       | GET and POST examples — edit and run                               |
| `explore/search.test.ts`    | `test.pick` with data from `data/` — one test, multiple variations |
| `explore/auth.test.ts`      | Multi-step auth flow — login, use token, get profile               |
| `data/search-examples.json` | Search parameters for pick examples                                |

## Links

- [Glubean SDK on JSR](https://jsr.io/@glubean/sdk) — API reference and examples
- [VS Code Extension](https://marketplace.visualstudio.com/items?itemName=glubean.glubean) — play buttons, trace viewer,
  diff
- [Documentation](https://glubean.com/docs)

## This is just the surface

You're seeing a minimal feature set. To unlock the full power of Glubean, start fresh in a new directory:

```bash
mkdir my-api-tests && cd my-api-tests
glubean init
```

Choose **Best Practice** to get:

- **`tests/` directory** with CI-ready test suites that run on every push
- **Multi-environment support** — same tests against staging and production with different `.env` files
- **Data-driven tests** with `test.each` — generate dozens of tests from CSV, JSON, or YAML
- **Schema validation** — auto-validate requests and responses against Zod/Valibot schemas
- **Git hooks** that keep `metadata.json` in sync automatically
- **GitHub Actions** workflow for CI verification on every PR
- **AI agent guidelines** (`AGENTS.md`) so your AI assistant writes tests correctly from day one
- **OpenAPI coverage** — see which endpoints have tests and which don't

The tests you write locally become continuous verification in the cloud. One `git push` turns them into scheduled runs,
multi-environment execution, and Slack alerts when something breaks. No rewrites needed.
