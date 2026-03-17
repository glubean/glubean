# Glubean Cheatsheet Index

Quick lookup for AI agents. Read this first, then open only the files you need.

## Reference

| File | When to read |
|------|-------------|
| [sdk-reference.md](sdk-reference.md) | Need full API surface — test(), ctx, expect, HTTP client, data loading |
| [cli-reference.md](cli-reference.md) | Need to run, filter, upload, or init a project |

## Patterns

| File | When to use |
|------|------------|
| [configure.md](patterns/configure.md) | Setting up HTTP client, env vars, secrets, plugins — **read this first for any new project** |
| [smoke.md](patterns/smoke.md) | Simple single-endpoint health/smoke test |
| [crud.md](patterns/crud.md) | Create → Read → Update → Delete with setup/teardown cleanup |
| [auth.md](patterns/auth.md) | Login flow, token management, protected endpoints |
| [data-driven.md](patterns/data-driven.md) | `test.each` (one file = one case) and `test.pick` (named cases, merged files) |
| [errors.md](patterns/errors.md) | Negative tests — 401, 403, 404, 422 |
| [polling.md](patterns/polling.md) | Async jobs, `pollUntil`, eventual consistency |
| [schema.md](patterns/schema.md) | Zod schema validation on API responses |
| [metrics.md](patterns/metrics.md) | Custom performance metrics, duration tracking |
| [session.md](patterns/session.md) | Cross-file shared state via `ctx.session` (auth token reuse, workflow chains) |
| [browser.md](patterns/browser.md) | Browser testing — setup, navigation, forms, scraping, dynamic elements |
| [ai-contracts.md](patterns/ai-contracts.md) | Testing AI/LLM endpoints — schema validation, consistency, regression |

## Rules (always follow)

1. **Secrets → `.env.secrets`**, public vars → `.env`. NEVER inline as `const`.
2. **Use `configure()`** for HTTP clients — never raw `fetch()`.
3. **Tags on every test** — `["smoke"]`, `["api"]`, `["e2e"]`, etc.
4. **Teardown** any test that creates resources.
5. **IDs**: kebab-case, unique across project.
6. **Type your responses**: `.json<{ id: string }>()`, never `.json<any>()`.
