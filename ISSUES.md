# Known Issues

## High Priority

### 1. Add tests for MCP package

**Severity:** High

The `mcp` package has zero test coverage.

### 2. Add bundle signature verification to worker

**Severity:** High

Worker downloads and extracts tar bundles from the control plane without signature verification before execution.

## Low Priority

### 3. Reduce console.log usage

**Severity:** Low

~115 `console.log` occurrences across packages (mostly in CLI commands and runner harness; many in comments/examples). Consider structured logging and making debug output opt-in.

### 4. Improve test coverage for scanner and redaction

**Severity:** Low

- Scanner has only one test file (`mod_test.ts`)
- Redaction has one test file (`engine_test.ts`); individual plugins have no tests

### 5. Add contributing workflow and migration guide

**Severity:** Low

CONTRIBUTING.md exists but is brief. No migration guide for users upgrading between versions.

---

## Resolved

- ~~Remove legacy API exports~~ — `testCase`/`testSuite` no longer exist in the SDK.
- ~~Version inconsistencies~~ — `redaction/package.json` aligned to 0.10.0.
- ~~Add missing READMEs~~ — `scanner`, `redaction`, `mcp` now have READMEs (marked experimental).
- ~~Make API URLs configurable~~ — CLI already supports `--api-url` and `GLUBEAN_API_URL` env; default extracted to `cli/lib/constants.ts` and unified to `api.glubean.com`. Worker and MCP were already configurable.
