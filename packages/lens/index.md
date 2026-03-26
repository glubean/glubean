# Glubean Lens Index

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
| [builder-reuse.md](patterns/builder-reuse.md) | Multi-step builder, `.use()` / `.group()` for reusable step sequences |
| [data-driven.md](patterns/data-driven.md) | `test.each` (one file = one case) and `test.pick` (named cases, merged files) |
| [errors.md](patterns/errors.md) | Negative tests — 401, 403, 404, 422 |
| [polling.md](patterns/polling.md) | Async jobs, `pollUntil`, eventual consistency |
| [schema.md](patterns/schema.md) | Zod schema validation on API responses |
| [metrics.md](patterns/metrics.md) | Custom performance metrics, duration tracking |
| [session.md](patterns/session.md) | Cross-file shared state via `defineSession()` + `ctx.session` (auth token reuse, workflow chains) |
| [browser.md](patterns/browser.md) | Browser testing — setup, navigation, forms, scraping, dynamic elements |

## Plugins

| File | When to use |
|------|------------|
| [plugins.md](patterns/plugins.md) | Plugin index — **check here before writing auth/plugin code by hand** |
| [auth.md](patterns/auth.md) | `@glubean/auth` — bearer, apiKey, basic, OAuth2, withLogin, combining strategies |

## Rules (always follow)

1. **Secrets → `.env.secrets`**, public vars → `.env`. NEVER inline as `const`.
2. **Use `configure()`** for HTTP clients — never raw `fetch()`. Use `{{KEY}}` for env references, bare strings for literals.
3. **Tags on every test** — `["smoke"]`, `["api"]`, `["e2e"]`, etc.
4. **Teardown** any test that creates resources.
5. **IDs**: kebab-case, unique across project.
6. **Type your responses**: `.json<{ id: string }>()`, never `.json<any>()`.
7. **One export per endpoint**: data-driven (`test.each`/`test.pick`) is for varying **parameters** on the same endpoint, not for grouping different endpoints.
