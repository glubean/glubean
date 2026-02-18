# Local-First Architecture

Glubean is designed as a **local-first** testing tool. The inner loop — write, run, debug — happens entirely on your
machine.

## Why Local?

| Benefit              | Description                                              |
| -------------------- | -------------------------------------------------------- |
| **Access localhost** | Test against local dev servers, databases, internal APIs |
| **No queue**         | Instant execution, fast feedback loop                    |
| **Zero cost**        | Uses your machine, no cloud compute charges              |
| **Debugging**        | Full IDE debugging support with `--debug` flag           |

## Design Principles

1. **Parity:** Local execution uses the exact same `@glubean/runner` package as remote execution. "Works on my machine"
   means "works everywhere."
2. **Zero Config:** Deno handles dependencies — no `npm install`, no build step.
3. **Fast Feedback:** Sub-second startup. Write a test, run it immediately.

## How It Works

When you run `glubean run ./test.ts`:

1. **Environment Loading** — CLI loads `.env` and `.env.secrets` from the current directory.
2. **Discovery** — CLI dynamically imports the test file and scans exports for test definitions.
3. **Execution** — CLI spawns a child Deno process (the harness), passes environment context, and runs the test
   function.
4. **Reporting** — Harness streams JSON events to stdout. CLI parses and pretty-prints results to the terminal.

## Filtering

```bash
# Run all tests in a directory
glubean run .

# Filter by name, id, or tag
glubean run . --filter "login"

# Interactive pick mode
glubean run . --pick
```

See [Getting Started](../getting-started.md) for the full local development workflow.
