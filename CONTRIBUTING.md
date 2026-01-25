# Contributing to Glubean

Thanks for your interest in contributing! Glubean is in its **early stage** — the core APIs and architecture are still evolving rapidly. Because of this, **we are not accepting large feature PRs at this time**. We want to get the fundamentals right before expanding scope.

That said, smaller contributions are very welcome.

## What We Welcome

- **Bug fixes** with clear reproduction steps
- **Documentation improvements** — typos, clarifications, examples
- **Test coverage** — additional test cases for edge cases
- **Small, focused improvements** — error messages, validation, developer experience

## What We Don't Accept (For Now)

- **Large feature PRs** — new commands, major refactors, new packages
- **Architectural changes** — the design is intentional and still being validated

If you have an idea for a bigger change, please open an issue first so we can discuss whether it fits the current roadmap.

## Development Setup

### Prerequisites

- [Deno](https://deno.com/) v2.0+
- [Node.js](https://nodejs.org/) 20+ (for the VSCode extension only)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/glubean/oss.git
cd oss

# Run tests
deno test -A

# Format code
deno fmt

# Lint
deno lint
```

### VSCode Extension

```bash
cd packages/vscode
npm install
npm run lint    # Type check
npm run build   # Bundle
npm run package # Create .vsix
```

## Code Standards

- **Language**: All comments and documentation in English
- **TypeScript**: Strict mode, explicit return types
- **JSDoc**: All exported APIs must have JSDoc with `@example` tags (see [AGENTS.md](AGENTS.md))
- **Testing**: Use Deno's built-in test runner (`deno test`)

## Commit Messages

We use conventional commits:

```
feat: add new feature
fix: fix a bug
docs: documentation changes
chore: maintenance tasks
refactor: code restructuring
test: test additions or fixes
```

## PR Guidelines

- Keep PRs focused and atomic — one concern per PR
- Include tests for bug fixes
- Update documentation if behavior changes
- PRs with tests are reviewed faster

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
