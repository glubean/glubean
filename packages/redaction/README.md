# @glubean/redaction

> **Early-stage / experimental** — This package is under active development and not yet intended for direct external
> consumption. APIs may change without notice. Full documentation will be added once the interface stabilises.

Plugin-based secrets and PII detection and masking engine. Used internally by the runner to redact sensitive values (API
keys, tokens, emails, etc.) from test output before persistence.

## Status

| Area          | Status       |
| ------------- | ------------ |
| API stability | Experimental |
| Test coverage | Minimal      |
| Documentation | Pending      |

## Dual-Runtime Vendoring

This package is the **source of truth**. A vendored Node-compatible copy lives in `glubean-v1/packages/redaction/`.

Because the OSS monorepo uses Deno (`import "./types.ts"`) while glubean-v1 uses Node/TypeScript (`import "./types"`),
the two copies cannot share the same source files directly — the `.ts` extension requirement is incompatible between
runtimes.

**Workflow:**

1. Make all changes here (oss `packages/redaction/`)
2. After changes are finalized, copy the source files to `glubean-v1/packages/redaction/src/`
3. Strip `.ts` extensions from all relative imports in the copied files
4. Verify both builds pass (`deno check` in oss, `pnpm build` in glubean-v1)

Do **not** edit the glubean-v1 copy directly — changes will be overwritten on the next sync.

## License

MIT
