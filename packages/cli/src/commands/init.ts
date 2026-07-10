/**
 * Init command - scaffolds a new Glubean test project with a 3-step wizard.
 *
 * Step 1: Project Type — Best Practice or Minimal
 * Step 2: API Setup — Base URL and optional OpenAPI spec (Best Practice only)
 * Step 3: Git & CI — Auto-detect/init git, hooks, GitHub Actions (Best Practice only)
 */

import { readFile, writeFile, stat, mkdir, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { confirm, select, input } from "@inquirer/prompts";
import { CLI_VERSION } from "../version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function isInteractive(): boolean {
  return !!process.stdin.isTTY;
}

/**
 * True when running in a real TTY (not piped stdin).
 * @inquirer/prompts only works in a real TTY.
 * Piped stdin (used by tests with GLUBEAN_FORCE_INTERACTIVE=1) falls back
 * to the plain readLine-based helpers.
 */
function useFancyPrompts(): boolean {
  return !!process.stdin.isTTY;
}

/**
 * Read a line from stdin. Works correctly with both TTY and piped input.
 */
function readLine(message: string): Promise<string> {
  return new Promise((res) => {
    process.stdout.write(message + " ");
    let data = "";
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      data += str;
      if (str.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        res(data.trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (useFancyPrompts()) {
    return await confirm({ message: question, default: defaultYes });
  }
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = await readLine(`${question} ${hint}`);
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return defaultYes;
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
  }
}

async function promptText(question: string, defaultValue: string): Promise<string> {
  if (useFancyPrompts()) {
    return await input({ message: question, default: defaultValue });
  }
  const answer = await readLine(`${question} [${defaultValue}]`);
  const trimmed = answer.trim();
  return trimmed || defaultValue;
}

async function promptChoice(
  question: string,
  options: { key: string; label: string; desc: string }[],
  defaultKey: string,
): Promise<string> {
  if (useFancyPrompts()) {
    return await select({
      message: question,
      choices: options.map((o) => ({
        name: `${o.label}  ${colors.dim}${o.desc}${colors.reset}`,
        value: o.key,
      })),
      default: defaultKey,
    });
  }
  console.log(`  ${question}\n`);
  for (const opt of options) {
    const marker = opt.key === defaultKey ? `${colors.green}❯${colors.reset}` : " ";
    console.log(
      `  ${marker} ${colors.bold}${opt.key}.${colors.reset} ${opt.label}  ${colors.dim}${opt.desc}${colors.reset}`,
    );
  }
  console.log();

  while (true) {
    const answer = await readLine(
      `  Enter choice ${colors.dim}[${defaultKey}]${colors.reset}`,
    );
    const trimmed = answer.trim();
    if (!trimmed) return defaultKey;
    const match = options.find((o) => o.key === trimmed);
    if (match) return match.key;
  }
}

function validateBaseUrl(raw: string): { ok: true; value: string } | {
  ok: false;
  reason: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "URL cannot be empty." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "Must be a valid absolute URL, for example: https://api.example.com",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// are supported." };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: "Hostname is required (for example: localhost)." };
  }

  const normalized = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    return { ok: true, value: normalized.slice(0, -1) };
  }
  return { ok: true, value: normalized };
}

function validateBaseUrlOrExit(raw: string, source: string): string {
  const result = validateBaseUrl(raw);
  if (result.ok) return result.value;

  console.error(
    `Invalid base URL from ${source}: ${result.reason}\n` +
      "Example: --base-url https://api.example.com",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCliTemplate(relativePath: string): Promise<string> {
  const templatePath = resolve(__dirname, "../../templates", relativePath);
  return await readFile(templatePath, "utf-8");
}

type FileEntry = {
  path: string;
  content: string | (() => Promise<string>);
  description: string;
};

async function resolveContent(
  content: string | (() => Promise<string>),
): Promise<string> {
  return typeof content === "function" ? await content() : content;
}

// ---------------------------------------------------------------------------
// Templates — Standard project
// ---------------------------------------------------------------------------

function resolveSdkVersion(): string {
  // Read the SDK version from the CLI's own package.json dependencies
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const sdkDep = pkg.dependencies?.["@glubean/sdk"];
  if (!sdkDep) {
    throw new Error(
      'Unable to resolve "@glubean/sdk" dependency from @glubean/cli package.json',
    );
  }
  // Strip workspace: prefix if present, otherwise return as-is
  return sdkDep.replace(/^workspace:\*?/, "latest");
}

const SDK_VERSION = resolveSdkVersion();

function makePackageJson(_baseUrl: string): string {
  return (
    JSON.stringify(
      {
        name: "my-glubean-tests",
        version: "0.1.0",
        type: "module",
        scripts: {
          test: "glubean run --profile local",
          "test:ci": "glubean ci run",
        },
        dependencies: {
          "@glubean/sdk": SDK_VERSION,
          // contracts/users.contract.ts (written below) imports zod directly
          // for its schema definitions — GLU-114 / GitHub report: without
          // this, a fresh `glubean init` project fails to resolve zod.
          zod: "^4.0.0",
          // Runner must be a direct dep (not only transitive via the glubean CLI).
          // pnpm does not hoist transitive deps — VSCode extension probes
          // node_modules/@glubean/runner; missing → bundled fallback runner →
          // second @glubean/sdk instance → configure() throws.
          "@glubean/runner": SDK_VERSION,
          // CLI must be a direct dep too (GLU-110 / GitHub #9). Without it,
          // node_modules/.bin has no `glubean` binary, so the bare `glubean`
          // in the scripts below has nothing local to resolve to. With a
          // stale global `glubean` on PATH, that silently runs the wrong
          // version ("unknown option '--profile'" et al) instead of
          // erroring; `npx glubean` in CI is not guaranteed to avoid this
          // either without a local bin present. Installing @glubean/cli
          // here guarantees node_modules/.bin/glubean exists and resolves
          // first for both invocation styles.
          "@glubean/cli": SDK_VERSION,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

// Canonical glubean.yaml emitted by `glubean init` for non-contract-first
// projects. Generated by Phase 4 of the config-profiles plan
// (`04-config-profiles-public-demo-plan.zh.md` §"新配置文件"). Suites
// declared but kept simple: tests only. Empty `contracts` suite stays
// out of the template — non-contract-first init doesn't create the
// contracts/ directory, and declaring a suite that resolves to zero
// files would trip the per-suite empty-files check.
const GLUBEAN_YAML_DEFAULT = `version: 1

defaults:
  redaction:
    # Full redaction: secrets are replaced with a fixed marker, no
    # prefix/suffix characters revealed.
    replacementFormat: simple

suites:
  tests:
    target: ./tests
    kinds: [test]
  explore:
    target: ./explore
    kinds: [test]

profiles:
  local:
    suites: [tests]

  ci:
    suites: [tests]
    selection:
      excludeTags: [manual, destructive]
    execution:
      failFast: true
      concurrency: 2
    reporters:
      junit: .glubean/results/junit.xml
      resultJson: .glubean/results/ci.result.json

  explore:
    suites: [explore]
`;

// Contract-first variant: declares BOTH \`contracts\` and \`tests\` suites
// and runs both in the local + ci profiles, per plan §Phase 4 task 5
// "contract-first init 默认 suites 包含 contracts 和 tests". A starter
// tests/sample.test.ts is also written below so multi-suite CI doesn't
// trip the per-suite empty-files check out of the box.
const GLUBEAN_YAML_CONTRACT_FIRST = `version: 1

defaults:
  redaction:
    # Full redaction: secrets are replaced with a fixed marker, no
    # prefix/suffix characters revealed.
    replacementFormat: simple

suites:
  contracts:
    target: ./contracts
    kinds: [contract, flow]
  tests:
    target: ./tests
    kinds: [test]

profiles:
  local:
    suites: [contracts, tests]

  ci:
    suites: [contracts, tests]
    selection:
      excludeTags: [manual, destructive]
    execution:
      failFast: true
      concurrency: 2
    reporters:
      junit: .glubean/results/junit.xml
      resultJson: .glubean/results/ci.result.json

  contract-smoke:
    suites: [contracts]
    selection:
      tags: [smoke]
`;

// Combined yaml for the default init template (tests + contracts).
// explore/ suite is intentionally omitted — the skill creates it on demand.
const GLUBEAN_YAML_INIT = `version: 1

defaults:
  redaction:
    replacementFormat: simple

suites:
  tests:
    target: ./tests
    kinds: [test]
  contracts:
    target: ./contracts
    kinds: [contract, flow]

profiles:
  local:
    suites: [tests, contracts]

  ci:
    suites: [tests, contracts]
    selection:
      excludeTags: [manual, destructive]
    execution:
      failFast: true
      concurrency: 2
    reporters:
      junit: .glubean/results/junit.xml
      resultJson: .glubean/results/ci.result.json

  contract-smoke:
    suites: [contracts]
    selection:
      tags: [smoke]
`;

// Example test file — uses dummyjson.com (the default BASE_URL).
// Users replace with paths that match their own API.
const API_TEST_TEMPLATE = `import { configure, test } from "@glubean/sdk";

const { http } = configure({
  http: { prefixUrl: "{{BASE_URL}}" },
});

export const listUsers = test(
  { id: "users-list", tags: ["smoke"] },
  async ({ expect }) => {
    const res = await http.get("users?limit=5");
    expect(res).toHaveStatus(200);
    const body = await res.json<{ users: unknown[]; total: number }>();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  },
);

export const getUser = test(
  { id: "users-get", tags: ["smoke"] },
  async ({ expect }) => {
    const res = await http.get("users/1");
    expect(res).toHaveStatus(200);
    const body = await res.json<{ id: number; firstName: string }>();
    expect(typeof body.id).toBe("number");
    expect(typeof body.firstName).toBe("string");
  },
);
`;

// Example contract file — uses dummyjson.com (the default BASE_URL).
const USERS_CONTRACT_TEMPLATE = `import { contract, configure } from "@glubean/sdk";
import { z } from "zod";

const { http: api } = configure({
  http: { prefixUrl: "{{BASE_URL}}" },
});

const usersApi = contract.http.with("users", {
  client: api,
  security: null,
});

const UserSchema = z.object({
  id: z.number(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
});

// @contract
export const getUser = usersApi("user-get", {
  endpoint: "GET /users/:id",
  feature: "Users",
  description: "Fetch a single user by ID",
  tags: ["smoke"],
  cases: {
    found: {
      description: "returns the user profile when the ID exists",
      pathParams: { id: "1" },
      expect: { status: 200, schema: UserSchema },
    },
    notFound: {
      description: "returns 404 when the user ID does not exist",
      pathParams: { id: "0" },
      expect: { status: 404 },
    },
  },
});
`;

const CONTRACT_FIRST_SAMPLE_TEST = `import { test } from "@glubean/sdk";

/**
 * Starter test so the canonical CI profile (suites: [contracts, tests])
 * doesn't trip "zero files" on a brand-new contract-first project.
 * Delete this file once you've added real tests under ./tests.
 */
export const placeholder = test(
  { id: "placeholder", tags: ["smoke"] },
  async (ctx) => {
    ctx.assert(true, "starter test — replace me");
  },
);
`;

function makeEnvFile(baseUrl: string): string {
  return `# Environment variables for tests
BASE_URL=${baseUrl}
`;
}

const ENV_SECRETS = `# Credentials and other secrets for tests (this file is gitignored)
# Example: API_KEY=your-secret-here
`;

const GITIGNORE = `# Secrets (all env-specific secrets files)
.env.secrets
.env.*.secrets

# Local overrides (personal config, not shared)
*.local.json
*.local.yaml
*.local.yml

# Personal explore directory
local/

# Log files
*.log

# Result files (generated by glubean run)
*.result.json

# Node
node_modules/

# Glubean internal
.glubean/
`;

const GLUBEAN_MD_TEMPLATE = `# Project Test Conventions

<!-- This file is read by the Glubean AI skill before generating tests.    -->
<!-- Fill in the sections below. The more context you add, the better the  -->
<!-- generated tests will be — especially Business Rules and API Reference. -->

## Auth
<!-- How tests should authenticate. e.g.:
     "Bearer token — put API_KEY in .env.secrets, use configure({ http: { headers: { Authorization: 'Bearer {{API_KEY}}' } } })"
     "No auth — public API"
     "Session cookie — use session-auth pattern, see patterns/session-auth.md" -->

## API Reference
<!-- Where the API surface is defined. Pick one or more:
     - OpenAPI spec: "context/openapi.json — run \`glubean spec split\` to index it"
     - Route handlers: "view ../src/routes/" or specific files like "view ../src/routes/users.ts"
     - Markdown docs: "context/api-reference.md"
     Leave empty if you have no docs yet — the agent will discover by running a trace. -->

## Business Rules
<!-- The rules and invariants tests should verify. e.g.:
     - Only admins can create or delete users. Non-admin returns 403.
     - Email must be unique. Duplicate returns 409.
     - Soft-delete only: GET /users/:id still works after DELETE, but list excludes them.
     Leave empty if none yet — add rules here as you discover them. -->

## Naming
<!-- e.g. "Test IDs: {resource}-{action}, e.g. user-create, order-list" -->

## Tags
<!-- e.g. "Always tag with team: team:payments" -->

## Notes
<!-- Any other conventions the AI should follow -->
`;

const TYPES_README = `# Shared Response Types

Define reusable TypeScript types for API responses here.
Tests import from this directory instead of writing inline types.

## Convention

One file per service or API domain:

\`\`\`
types/
├── users.ts      # { id: string; name: string; email: string }
├── products.ts   # { id: number; title: string; price: number }
└── common.ts     # Pagination, error responses, etc.
\`\`\`

## Usage

\`\`\`ts
import type { User } from "../types/users.js";

const user = await ctx.http.get("/users/1").json<User>();
\`\`\`

When the AI skill writes tests, it checks this directory first
before creating inline types. Keep types here to avoid duplication.
`;

const LOCAL_README = `# Local Tests

This directory is for **personal** exploratory tests — gitignored by default.

Use it to try things out without affecting the team's test suite.
When a test is ready to share, move it to \`explore/\` or \`tests/\`.

\`\`\`bash
# Run a local test
npx glubean run local/my-test.test.ts
\`\`\`
`;

const PRE_COMMIT_HOOK = `#!/bin/sh
set -e

glubean scan

if [ -n "$(git diff --name-only -- metadata.json)" ]; then
  echo "metadata.json updated. Please git add metadata.json"
  exit 1
fi
`;

const PRE_PUSH_HOOK = `#!/bin/sh
set -e

glubean validate-metadata
`;

const GITHUB_ACTION_METADATA = `name: Glubean Metadata

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  metadata:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install dependencies
        run: npm ci
      - name: Generate metadata.json
        run: npx glubean scan
      - name: Verify metadata.json
        run: git diff --exit-code metadata.json
`;

const GITHUB_ACTION_TESTS = `name: Glubean Tests

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm ci

      - name: Write secrets
        run: |
          echo "USERNAME=\${{ secrets.USERNAME }}" >> .env.secrets
          echo "PASSWORD=\${{ secrets.PASSWORD }}" >> .env.secrets

      - name: Run tests
        # The ci profile in glubean.yaml already sets reporters.resultJson
        # (.glubean/results/ci.result.json) + reporters.junit, so no CLI
        # override is needed. Adding --result-json without a path here
        # would push output to the default glubean-run.result.json and
        # bypass the profile-owned location.
        run: npx glubean ci run

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          # include-hidden-files: glubean.yaml CI profile writes outputs
          # under \`.glubean/results/\`; upload-artifact@v4 skips hidden
          # paths by default and would silently drop the junit + result.json.
          include-hidden-files: true
          path: |
            .glubean/results/**
            **/*.junit.xml
            **/*.result.json
`;

// ---------------------------------------------------------------------------
// Dependency installation
// ---------------------------------------------------------------------------

async function installDependencies(): Promise<void> {
  console.log(
    `\n${colors.dim}Installing dependencies...${colors.reset}`,
  );
  return new Promise((res) => {
    execFile("npm", ["install"], { encoding: "utf-8" }, (error, _stdout, stderr) => {
      if (!error) {
        console.log(
          `  ${colors.green}✓${colors.reset} Dependencies installed\n`,
        );
      } else {
        console.log(
          `  ${colors.yellow}⚠${colors.reset} Failed to install dependencies. Run ${colors.cyan}npm install${colors.reset} manually.`,
        );
        if (stderr?.trim()) {
          console.log(`  ${colors.dim}${stderr.trim()}${colors.reset}\n`);
        }
      }
      res();
    });
  });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type InitWorkflow = "test" | "contract-first";

export interface InitOptions {
  minimal?: boolean;
  contractFirst?: boolean;
  hooks?: boolean;
  githubActions?: boolean;
  aiTools?: boolean;
  interactive?: boolean;
  overwrite?: boolean;
  overwriteHooks?: boolean;
  overwriteActions?: boolean;
  baseUrl?: string;
  /** Named scaffold template. Currently: "demo" (public demo project). */
  template?: string;
}

// ---------------------------------------------------------------------------
// Main init command — 3-step wizard
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://dummyjson.com";

export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log(`\n${colors.bold}${colors.cyan}🫘 Glubean Init${colors.reset}\n`);

  // `--template demo` is a non-interactive named scaffold — short-circuit
  // before the TTY check + workflow prompt. Validate the name so a typo
  // (e.g. `--template demoo`) fails loudly instead of silently falling
  // through to the default workflow.
  if (options.template !== undefined) {
    if (options.template !== "demo") {
      console.error(
        `Unknown --template "${options.template}". Supported: demo.`,
      );
      process.exit(1);
    }
    await initDemo(options.overwrite ?? false);
    return;
  }

  const interactive = options.interactive ?? true;
  const forceInteractive = process.env["GLUBEAN_FORCE_INTERACTIVE"] === "1";
  if (interactive && !isInteractive() && !forceInteractive) {
    console.error(
      "Interactive init requires a TTY. Use --no-interactive and pass --ai-tools/--hooks/--github-actions flags.",
    );
    process.exit(1);
  }

  // ── Contract-first shortcut (legacy flag) ────────────────────────────────

  if (options.contractFirst) {
    await initContractFirst(options.overwrite ?? false);
    return;
  }

  // ── Base URL ──────────────────────────────────────────────────────────────

  let baseUrl: string;
  if (options.baseUrl) {
    baseUrl = validateBaseUrlOrExit(options.baseUrl, "--base-url");
  } else if (interactive) {
    const raw = await promptText(
      "What's your API base URL for your default test environment?",
      DEFAULT_BASE_URL,
    );
    baseUrl = validateBaseUrlOrExit(raw, "prompt");
  } else {
    baseUrl = DEFAULT_BASE_URL;
  }

  // ── Overwrite check ───────────────────────────────────────────────────────

  if (interactive && !options.overwrite) {
    const hasExisting =
      (await fileExists("package.json")) || (await fileExists(".env"));
    if (hasExisting) {
      console.log(
        `\n  ${colors.yellow}⚠${colors.reset} Existing files detected in this directory.\n`,
      );
      const overwrite = await promptYesNo("Overwrite existing files?", false);
      if (overwrite) {
        options.overwrite = true;
      } else {
        console.log(
          `\n  ${colors.dim}Keeping existing files — new files will still be created${colors.reset}\n`,
        );
      }
    }
  }

  // ── Create files ─────────────────────────────────────────────────────────

  console.log(
    `\n${colors.dim}━━━ Creating project ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "package.json",
      content: makePackageJson(baseUrl),
      description: "Package config with scripts",
    },
    {
      path: "glubean.yaml",
      content: GLUBEAN_YAML_INIT,
      description: "Suites + profiles (tests, contracts, CI)",
    },
    {
      path: ".env",
      content: makeEnvFile(baseUrl),
      description: "Environment variables",
    },
    {
      path: ".env.secrets",
      content: ENV_SECRETS,
      description: "Credentials (gitignored)",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "GLUBEAN.md",
      content: GLUBEAN_MD_TEMPLATE,
      description: "Project conventions for AI skill",
    },
    {
      path: "tests/api.test.ts",
      content: API_TEST_TEMPLATE,
      description: "Example test (replace with your API paths)",
    },
    {
      path: "contracts/users.contract.ts",
      content: USERS_CONTRACT_TEMPLATE,
      description: "Example contract (replace with your endpoints)",
    },
  ];

  const enableHooks = options.hooks ?? false;
  const enableActions = options.githubActions ?? false;
  const hasGit = await fileExists(".git");
  if (enableHooks && !hasGit) {
    console.error(
      "Error: --hooks requires a Git repository. Run `git init` first.",
    );
    process.exit(1);
  }

  if (enableHooks) {
    files.push(
      {
        path: ".git/hooks/pre-commit",
        content: PRE_COMMIT_HOOK,
        description: "Git pre-commit hook",
      },
      {
        path: ".git/hooks/pre-push",
        content: PRE_PUSH_HOOK,
        description: "Git pre-push hook",
      },
    );
  }

  if (enableActions) {
    files.push(
      {
        path: ".github/workflows/glubean-metadata.yml",
        content: GITHUB_ACTION_METADATA,
        description: "GitHub Actions metadata workflow",
      },
      {
        path: ".github/workflows/glubean-tests.yml",
        content: GITHUB_ACTION_TESTS,
        description: "GitHub Actions test workflow",
      },
    );
  }

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  const shouldOverwrite = (path: string): boolean => {
    if (options.overwrite) return true;
    if (options.overwriteHooks && path.startsWith(".git/hooks/")) return true;
    if (
      options.overwriteActions &&
      path.startsWith(".github/workflows/glubean-")
    ) {
      return true;
    }
    return false;
  };

  for (const file of files) {
    const existedBefore = await fileExists(file.path);
    if (existedBefore) {
      if (!shouldOverwrite(file.path)) {
        console.log(
          `  ${colors.dim}skip${colors.reset}  ${file.path} (already exists)`,
        );
        skipped++;
        continue;
      }
    }

    const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
    if (parentDir) {
      await mkdir(parentDir, { recursive: true });
    }
    const content = await resolveContent(file.content);
    await writeFile(file.path, content, "utf-8");
    if (file.path.startsWith(".git/hooks/")) {
      try {
        await chmod(file.path, 0o755);
      } catch {
        // Ignore chmod errors on unsupported platforms
      }
    }
    if (existedBefore && shouldOverwrite(file.path)) {
      console.log(
        `  ${colors.yellow}overwrite${colors.reset} ${file.path} - ${file.description}`,
      );
      overwritten++;
    } else {
      console.log(
        `  ${colors.green}create${colors.reset} ${file.path} - ${file.description}`,
      );
      created++;
    }
  }

  console.log(
    `\n${colors.bold}Summary:${colors.reset} ${created} created, ${overwritten} overwritten, ${skipped} skipped\n`,
  );

  if (created > 0) {
    await installDependencies();

    console.log(`\n${colors.bold}Next steps:${colors.reset}`);
    console.log(
      `\n  1. ${colors.cyan}npm test${colors.reset}  ${colors.dim}— runs example tests + contracts against ${baseUrl}${colors.reset}`,
    );
    console.log(
      `  2. Edit ${colors.cyan}tests/api.test.ts${colors.reset} and ${colors.cyan}contracts/users.contract.ts${colors.reset} for your API`,
    );
    console.log(
      `  3. Add your AI skill  ${colors.dim}(run once)${colors.reset}`,
    );
    console.log(`     ${colors.bold}${colors.cyan}npx skills add glubean/skill${colors.reset}`);
    console.log(`     ${colors.bold}${colors.cyan}npx add-mcp "npx -y @glubean/mcp@latest"${colors.reset}`);
    console.log(
      `\n  ${colors.dim}Want 35+ examples? git clone https://github.com/glubean/cookbook${colors.reset}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Try Glubean (clone cookbook)
// ---------------------------------------------------------------------------

async function initTryCookbook(): Promise<void> {
  const targetDir = "cookbook";
  const repoUrl = "https://github.com/glubean/cookbook.git";

  if (await fileExists(targetDir)) {
    console.log(
      `  ${colors.yellow}⚠${colors.reset} ${colors.cyan}${targetDir}/${colors.reset} already exists. cd into it and run ${colors.cyan}npm install${colors.reset}.\n`,
    );
    return;
  }

  console.log(
    `${colors.dim}  Cloning cookbook — 35+ runnable examples across 11 API patterns${colors.reset}\n`,
  );

  try {
    const { execSync } = await import("node:child_process");
    execSync(`git clone ${repoUrl} ${targetDir}`, { stdio: "inherit" });
    console.log("");
    execSync("npm install", { cwd: targetDir, stdio: "inherit" });
  } catch {
    console.error(
      `\n${colors.red}Failed to clone cookbook.${colors.reset} Try manually:\n  git clone ${repoUrl}\n  cd ${targetDir} && npm install\n`,
    );
    process.exit(1);
  }

  console.log(`\n${colors.bold}Next steps:${colors.reset}`);
  console.log(`\n  ${colors.cyan}cd ${targetDir}${colors.reset}\n`);
  console.log(`  Connect AI  ${colors.dim}(run once)${colors.reset}`);
  console.log(`    ${colors.bold}${colors.cyan}npx skills add glubean/skill${colors.reset}`);
  console.log(`    ${colors.bold}${colors.cyan}npx add-mcp "npx -y @glubean/mcp@latest"${colors.reset}\n`);
  console.log(
    `  1. Run ${colors.cyan}npx glubean run explore --tag smoke${colors.reset} to see tests pass`,
  );
  console.log(
    `  2. Browse ${colors.cyan}explore/${colors.reset} — 11 patterns (REST, auth, GraphQL, gRPC, SSE, WebSocket...)`,
  );
  console.log(
    `  3. When ready for your own project: ${colors.cyan}glubean init${colors.reset} in a new directory\n`,
  );
}

// ---------------------------------------------------------------------------
// Contract-first init
// ---------------------------------------------------------------------------

const CONTRACTS_README = `# Contracts

Executable API contracts — the source of truth for how the API should behave.

Create a scoped contract instance with \`contract.http.with()\`, then define endpoints:

\`\`\`typescript
import { contract } from "@glubean/sdk";
import { api } from "../configure.js";

const userApi = contract.http.with("user", {
  client: api,
  security: "bearer",
});

// @contract
export const createUser = userApi("create-user", {
  endpoint: "POST /users",
  feature: "User Registration",
  description: "Create a new user account",
  cases: {
    success: {
      description: "Valid registration creates user and returns profile",
      body: { email: "test@example.com", password: "secure123" },
      expect: { status: 201 },
    },
    duplicateEmail: {
      description: "Already registered email is rejected",
      body: { email: "existing@example.com", password: "secure123" },
      expect: { status: 409 },
    },
  },
});
\`\`\`

## Lifecycle

1. Define: write contracts describing what the API should do
2. Red: implementation does not satisfy the contract yet
3. Green: implementation passes all contracts
4. Iterate: add error cases, auth, schema validation

## Rules

- Fix the implementation, not the contract
- Only change a contract when the business requirement changes
- Use business language in descriptions, not technical jargon
`;

const GLUBEAN_SETUP_TEMPLATE = `/**
 * Glubean plugin installation entry point.
 *
 * Runs once per process on \`glubean run\` / \`glubean contracts\` / MCP /
 * VSCode scan — wherever a Glubean tool needs plugin-registered matchers
 * and protocol adapters to be available before test files or \`.contract.ts\`
 * modules are imported.
 *
 * Add your project's plugins here. Example:
 *
 *   import { installPlugin } from "@glubean/sdk";
 *   import graphqlPlugin from "@glubean/graphql";
 *   import grpcPlugin from "@glubean/grpc";
 *
 *   await installPlugin(graphqlPlugin, grpcPlugin);
 *
 * If your project only uses HTTP contracts and built-in matchers, this
 * file can stay empty — the framework works out of the box.
 */

// No plugins installed by default. Uncomment and add imports above once
// you pull in @glubean/graphql, @glubean/grpc, or a custom plugin package.
export {};
`;

const EXAMPLE_CONTRACT = `import { contract, configure } from "@glubean/sdk";

const { http: api } = configure({
  http: { prefixUrl: "{{BASE_URL}}" },
});

const publicApi = contract.http.with("public", {
  client: api,
  security: null,
});

/**
 * Example contract — replace with your own endpoints.
 * Run with: npm run contract:run
 */
// @contract
export const healthCheck = publicApi("health-check", {
  endpoint: "GET /health",
  feature: "System",
  description: "Service health check",
  tags: ["smoke"],
  cases: {
    ok: {
      description: "Service is running and healthy",
      expect: { status: 200 },
    },
  },
});
`;

const CONTRACT_FIRST_PACKAGE_JSON = (sdkVersion: string) =>
  JSON.stringify(
    {
      name: "my-glubean-project",
      version: "0.1.0",
      type: "module",
      scripts: {
        "contract:run": "glubean run contracts/",
        "contract:verbose": "glubean run contracts/ --verbose",
        "contract:smoke": "glubean run --profile contract-smoke",
        test: "glubean run --profile local",
        "test:ci": "glubean ci run",
        scan: "glubean scan",
      },
      dependencies: {
        "@glubean/sdk": sdkVersion,
        zod: "^4.0.0",
        "@glubean/runner": sdkVersion,
        // CLI must be a direct dep too (GLU-110 / GitHub #9) — see the
        // comment in makePackageJson() for why the bare `glubean` in the
        // scripts above needs a local node_modules/.bin/glubean.
        "@glubean/cli": sdkVersion,
      },
    },
    null,
    2,
  ) + "\n";

const DEMO_PACKAGE_JSON = (sdkVersion: string) =>
  JSON.stringify(
    {
      name: "glubean-public-demo",
      version: "0.1.0",
      type: "module",
      scripts: {
        // `local` profile only — deterministic suites, always green.
        test: "glubean run --profile local",
        // Full narrative incl. flaky + canary. Runs fully local (no
        // upload). Exit code is intermittently non-zero BY DESIGN.
        "test:full": "glubean run --profile full",
        scan: "glubean scan",
      },
      dependencies: {
        "@glubean/sdk": sdkVersion,
        "@glubean/runner": sdkVersion,
        // CLI must be a direct dep too (GLU-110 / GitHub #9) — see the
        // comment in makePackageJson() for why the bare `glubean` in the
        // scripts above needs a local node_modules/.bin/glubean.
        "@glubean/cli": sdkVersion,
      },
    },
    null,
    2,
  ) + "\n";

/**
 * `glubean init --template demo` — scaffolds the public demo project
 * (Phase 6). Pairs with the standalone `glubean-demo-backend` service
 * (see glubean/docs/05-demo-project-design.zh.md). Static template
 * files live in packages/cli/templates/demo/**; only package.json
 * needs SDK-version injection.
 */
async function initDemo(overwrite: boolean): Promise<void> {
  console.log(
    `${colors.dim}  Demo — runnable public demo project (pairs with glubean-demo-backend)${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "package.json",
      content: DEMO_PACKAGE_JSON(SDK_VERSION),
      description: "Package config with local + full scripts",
    },
    {
      path: "README.md",
      content: () => readCliTemplate("demo/README.md"),
      description: "Demo narrative explainer",
    },
    {
      path: "glubean.yaml",
      content: () => readCliTemplate("demo/glubean.yaml"),
      description: "Demo config — stable / flaky / contract / canary suites",
    },
    {
      // Enables allowImportingTsExtensions so the `.ts` relative imports
      // (skill convention + required for contract discovery) typecheck
      // cleanly in editors / tsc. The project runs via tsx (`glubean
      // run`), so noEmit is fine.
      path: "tsconfig.json",
      content: () => readCliTemplate("demo/tsconfig.json"),
      description: "TS config (allowImportingTsExtensions for .ts imports)",
    },
    {
      path: ".env.example",
      content: () => readCliTemplate("demo/.env.example"),
      description: "Env vars template (MOCK_BACKEND_URL)",
    },
    {
      path: ".env.secrets.example",
      content: () => readCliTemplate("demo/.env.secrets.example"),
      description: "Secrets template (upload token — opt-in only)",
    },
    {
      // Sourced from gitignore.tpl, not .gitignore — npm pack omits
      // files literally named `.gitignore` from the published package,
      // so the template must use a non-ignored name. Written out to
      // the real `.gitignore` in the scaffolded project.
      path: ".gitignore",
      content: () => readCliTemplate("demo/gitignore.tpl"),
      description: "Git ignore rules",
    },
    {
      path: "glubean.setup.ts",
      content: GLUBEAN_SETUP_TEMPLATE,
      description: "Plugin bootstrap entry",
    },
    {
      path: "config/api.ts",
      content: () => readCliTemplate("demo/config/api.ts"),
      description: "Shared HTTP client (configure() once, imported everywhere)",
    },
    {
      path: "tests/api-stable/get-users.test.ts",
      content: () => readCliTemplate("demo/tests/api-stable/get-users.test.ts"),
      description: "Stable suite — deterministic 200 tests",
    },
    {
      path: "tests/api-flaky/search-flaky.test.ts",
      content: () => readCliTemplate("demo/tests/api-flaky/search-flaky.test.ts"),
      description: "Flaky suite — ~30% 503 (full profile only)",
    },
    {
      path: "tests/canary/synthetic-50pct-flaky.test.ts",
      content: () =>
        readCliTemplate("demo/tests/canary/synthetic-50pct-flaky.test.ts"),
      description: "In-process synthetic canary (full profile only)",
    },
    {
      path: "tests/contracts/stable/users-contract.contract.ts",
      content: () =>
        readCliTemplate("demo/tests/contracts/stable/users-contract.contract.ts"),
      description: "Stable contract guarding the API shape",
    },
  ];

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  for (const file of files) {
    const existedBefore = await fileExists(file.path);
    if (existedBefore && !overwrite) {
      console.log(
        `  ${colors.dim}skip${colors.reset}  ${file.path} (already exists)`,
      );
      skipped++;
      continue;
    }
    const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
    if (parentDir) await mkdir(parentDir, { recursive: true });
    const content = await resolveContent(file.content);
    await writeFile(file.path, content, "utf-8");
    if (existedBefore) {
      console.log(
        `  ${colors.yellow}overwrite${colors.reset} ${file.path} - ${file.description}`,
      );
      overwritten++;
    } else {
      console.log(
        `  ${colors.green}create${colors.reset} ${file.path} - ${file.description}`,
      );
      created++;
    }
  }

  console.log(
    `\n${colors.green}✓${colors.reset} Demo project scaffolded ` +
      `(${created} created${overwritten ? `, ${overwritten} overwritten` : ""}${skipped ? `, ${skipped} skipped` : ""}).\n`,
  );
  console.log(`${colors.dim}Next steps:${colors.reset}`);
  console.log(`  1. cp .env.example .env`);
  console.log(`  2. Set MOCK_BACKEND_URL (.env) to your deployed glubean-demo-backend`);
  console.log(`  3. npm install && npm test     ${colors.dim}# local profile — green${colors.reset}`);
  console.log(
    `  4. npm run test:full           ${colors.dim}# full narrative (flaky + canary), runs local${colors.reset}\n`,
  );
}

async function initContractFirst(overwrite: boolean): Promise<void> {
  console.log(
    `${colors.dim}  Contract-first — define API behavior before implementing${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "package.json",
      content: CONTRACT_FIRST_PACKAGE_JSON(SDK_VERSION),
      description: "Package config with contract + test scripts",
    },
    {
      path: ".env",
      content: `# Environment variables\n# Set BASE_URL to your API server once it's running\nBASE_URL=http://localhost:3000\n`,
      description: "Environment variables",
    },
    {
      path: ".env.secrets",
      content: "# Secrets (add to .gitignore)\n",
      description: "Secret variables",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "glubean.setup.ts",
      content: GLUBEAN_SETUP_TEMPLATE,
      description: "Plugin bootstrap entry (installs manifest-based plugins)",
    },
    {
      path: "contracts/README.md",
      content: CONTRACTS_README,
      description: "Executable contracts directory",
    },
    {
      path: "contracts/health.contract.ts",
      content: EXAMPLE_CONTRACT,
      description: "Example contract (replace with your own)",
    },
    {
      path: "types/README.md",
      content: TYPES_README,
      description: "Shared response types directory",
    },
    {
      path: "schemas/README.md",
      content: "# Schemas\n\nReusable Zod schemas for API response validation.\n",
      description: "Shared Zod schemas directory",
    },
    {
      path: "glubean.yaml",
      content: GLUBEAN_YAML_CONTRACT_FIRST,
      description: "Canonical Glubean project config (contracts + tests)",
    },
    {
      path: "tests/sample.test.ts",
      content: CONTRACT_FIRST_SAMPLE_TEST,
      description: "Starter test (so multi-suite CI has a file to run)",
    },
    {
      path: "GLUBEAN.md",
      content: GLUBEAN_MD_TEMPLATE,
      description: "Project conventions for AI skill",
    },
  ];

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  for (const file of files) {
    const existedBefore = await fileExists(file.path);
    if (existedBefore && !overwrite) {
      console.log(
        `  ${colors.dim}skip${colors.reset}  ${file.path} (already exists)`,
      );
      skipped++;
      continue;
    }

    const parentDir = file.path.substring(0, file.path.lastIndexOf("/"));
    if (parentDir) {
      await mkdir(parentDir, { recursive: true });
    }
    const content = await resolveContent(file.content);
    await writeFile(file.path, content, "utf-8");

    if (existedBefore) {
      console.log(
        `  ${colors.yellow}overwrite${colors.reset} ${file.path} - ${file.description}`,
      );
      overwritten++;
    } else {
      console.log(
        `  ${colors.green}create${colors.reset} ${file.path} - ${file.description}`,
      );
      created++;
    }
  }

  console.log(
    `\n${colors.bold}Summary:${colors.reset} ${created} created, ${overwritten} overwritten, ${skipped} skipped\n`,
  );

  if (created > 0) {
    await installDependencies();

    console.log(`${colors.bold}Next steps:${colors.reset}`);
    console.log(`\n  Connect AI  ${colors.dim}(run once)${colors.reset}`);
    console.log(`    ${colors.bold}${colors.cyan}npx skills add glubean/skill${colors.reset}`);
    console.log(`    ${colors.bold}${colors.cyan}npx add-mcp "npx -y @glubean/mcp@latest"${colors.reset}\n`);
    console.log(
      `  1. Try the example: ${colors.cyan}npm run contract:run${colors.reset}`,
    );
    console.log(
      `  2. Write contracts in ${colors.cyan}contracts/${colors.reset} using ${colors.cyan}contract.http.with()${colors.reset}`,
    );
    console.log(
      `  3. Implement the API, then run ${colors.cyan}npm run contract:run${colors.reset}`,
    );
    console.log(
      `  4. Iterate until green — fix implementation, not contracts\n`,
    );
  }
}
