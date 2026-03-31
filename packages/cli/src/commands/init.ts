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
import { confirm, select } from "@inquirer/prompts";
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
          test: "glubean run --config ci-config/default.yaml",
          "test:staging": "glubean run --config ci-config/staging.yaml",
          "test:ci": "glubean run --config ci-config/ci.yaml",
          explore: "glubean run --config ci-config/explore.yaml",
          scan: "glubean scan",
          "validate-metadata": "glubean validate-metadata",
        },
        dependencies: {
          "@glubean/sdk": SDK_VERSION,
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function makeEnvFile(baseUrl: string): string {
  return `# Environment variables for tests
BASE_URL=${baseUrl}
`;
}

const ENV_SECRETS = `# Secrets for tests (add this file to .gitignore)
# DummyJSON test credentials (public, safe to use)
USERNAME=emilys
PASSWORD=emilyspass
`;

function makeStagingEnvFile(baseUrl: string): string {
  const stagingUrl = baseUrl.replace(/\/\/([^/]+)/, "//staging.$1");
  return `# Staging environment variables
# Usage: glubean run --env-file .env.staging
BASE_URL=${stagingUrl}
`;
}

const ENV_STAGING_SECRETS = `# Staging secrets (gitignored)
# Usage: auto-loaded when --env-file .env.staging is used
# API_KEY=your-staging-api-key
USERNAME=
PASSWORD=
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

<!-- This file is read by the Glubean AI skill before generating tests. -->
<!-- Customize it to teach the AI your project's specific patterns. -->
<!-- Run \`npx skills add glubean/skill\` to install/update the AI skill. -->

## Auth
<!-- How should tests authenticate? e.g. "Use OAuth2 client credentials via configure()" -->

## Naming
<!-- e.g. "All test IDs start with the service name: user-xxx, order-xxx" -->

## Tags
<!-- e.g. "Always include team tag: team:payments" -->

## Structure
<!-- e.g. "Shared clients go in config/, tests in tests/{service}/" -->

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
        run: npx glubean run --ci --result-json

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: |
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

export type InitWorkflow = "try" | "test" | "contract-first";

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
}

// ---------------------------------------------------------------------------
// Main init command — 3-step wizard
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://dummyjson.com";

export async function initCommand(options: InitOptions = {}): Promise<void> {
  console.log(`\n${colors.bold}${colors.cyan}🫘 Glubean Init${colors.reset}\n`);

  const interactive = options.interactive ?? true;
  const forceInteractive = process.env["GLUBEAN_FORCE_INTERACTIVE"] === "1";
  if (interactive && !isInteractive() && !forceInteractive) {
    console.error(
      "Interactive init requires a TTY. Use --no-interactive and pass --ai-tools/--hooks/--github-actions flags.",
    );
    process.exit(1);
  }

  // ── Workflow ─────────────────────────────────────────────────────────────

  let workflow: InitWorkflow = options.contractFirst
    ? "contract-first"
    : "test";

  if (interactive && !options.contractFirst) {
    console.log(
      `${colors.dim}━━━ What kind of project? ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );
    const choice = await promptChoice(
      "What are you doing?",
      [
        {
          key: "1",
          label: "Try Glubean",
          desc: "Clone cookbook — 35+ runnable examples, ready in 30 seconds",
        },
        {
          key: "2",
          label: "Test an existing API",
          desc: "Full project — tests, CI config, types, schemas",
        },
        {
          key: "3",
          label: "Build contract-first for a new API",
          desc: "Define behavior before implementing — contracts, tests, types",
        },
      ],
      "1",
    );
    workflow = choice === "3" ? "contract-first" : choice === "2" ? "test" : "try";
  }

  if (interactive && !options.overwrite) {
    const hasExisting = await fileExists("package.json") ||
      await fileExists(".env");
    if (hasExisting) {
      console.log(
        `\n  ${colors.yellow}⚠${colors.reset} Existing Glubean files detected in this directory.\n`,
      );
      const overwrite = await promptYesNo(
        "Overwrite existing files?",
        false,
      );
      if (overwrite) {
        options.overwrite = true;
      } else {
        console.log(
          `\n  ${colors.dim}Keeping existing files — new files will still be created${colors.reset}\n`,
        );
      }
    }
  }

  if (workflow === "try") {
    await initTryCookbook();
    return;
  }

  if (workflow === "contract-first") {
    await initContractFirst(options.overwrite ?? false);
    return;
  }

  // ── Best Practice — API Setup (no prompt, uses default) ──────────────────

  const baseUrl = options.baseUrl ? validateBaseUrlOrExit(options.baseUrl, "--base-url") : DEFAULT_BASE_URL;

  // Legacy flags — still supported for backward compatibility
  let enableHooks = options.hooks ?? false;
  let enableActions = options.githubActions ?? false;
  const hasGit = await fileExists(".git");
  if (enableHooks && !hasGit) {
    console.error(
      "Error: --hooks requires a Git repository. Run `git init` first.",
    );
    process.exit(1);
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
      path: ".env",
      content: makeEnvFile(baseUrl),
      description: "Environment variables",
    },
    {
      path: ".env.secrets",
      content: ENV_SECRETS,
      description: "Secret variables",
    },
    {
      path: ".env.staging",
      content: makeStagingEnvFile(baseUrl),
      description: "Staging environment variables",
    },
    {
      path: ".env.staging.secrets",
      content: ENV_STAGING_SECRETS,
      description: "Staging secret variables",
    },
    {
      path: "ci-config/default.yaml",
      content: () => readCliTemplate("ci-config/default.yaml"),
      description: "Default run config",
    },
    {
      path: "ci-config/ci.yaml",
      content: () => readCliTemplate("ci-config/ci.yaml"),
      description: "CI run config",
    },
    {
      path: "ci-config/staging.yaml",
      content: () => readCliTemplate("ci-config/staging.yaml"),
      description: "Staging run config",
    },
    {
      path: "ci-config/explore.yaml",
      content: () => readCliTemplate("ci-config/explore.yaml"),
      description: "Explore run config",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "README.md",
      content: () => readCliTemplate("README.md"),
      description: "Project README",
    },
    {
      path: "context/openapi.sample.json",
      content: () => readCliTemplate("openapi.sample.json"),
      description: "Sample OpenAPI spec (mock)",
    },
    {
      path: "tests/demo.test.ts",
      content: () => readCliTemplate("demo.test.ts.tpl"),
      description: "Demo tests (rich output for dashboard preview)",
    },
    {
      path: "tests/data-driven.test.ts",
      content: () => readCliTemplate("data-driven.test.ts.tpl"),
      description: "Data-driven test examples (JSON, CSV, YAML)",
    },
    {
      path: "tests/pick.test.ts",
      content: () => readCliTemplate("pick.test.ts.tpl"),
      description: "Example selection with test.pick (inline + JSON)",
    },
    {
      path: "data/users.json",
      content: () => readCliTemplate("data/users.json"),
      description: "Sample JSON test data",
    },
    {
      path: "data/endpoints.csv",
      content: () => readCliTemplate("data/endpoints.csv"),
      description: "Sample CSV test data",
    },
    {
      path: "data/scenarios.yaml",
      content: () => readCliTemplate("data/scenarios.yaml"),
      description: "Sample YAML test data",
    },
    {
      path: "data/create-user.json",
      content: () => readCliTemplate("data/create-user.json"),
      description: "Named examples for test.pick",
    },
    {
      path: "explore/api.test.ts",
      content: () => readCliTemplate("minimal-api.test.ts.tpl"),
      description: "Explore — GET and POST basics",
    },
    {
      path: "explore/search.test.ts",
      content: () => readCliTemplate("minimal-search.test.ts.tpl"),
      description: "Explore — parameterized search with test.pick",
    },
    {
      path: "explore/auth.test.ts",
      content: () => readCliTemplate("minimal-auth.test.ts.tpl"),
      description: "Explore — multi-step auth flow",
    },
    {
      path: "data/search-examples.json",
      content: () => readCliTemplate("data/search-examples.json"),
      description: "Search examples for test.pick",
    },
    {
      path: "types/README.md",
      content: TYPES_README,
      description: "Shared response types directory",
    },
    {
      path: "types/data-driven.ts",
      content: () => readCliTemplate("types/data-driven.ts"),
      description: "Types for data-driven test data",
    },
    {
      path: "GLUBEAN.md",
      content: GLUBEAN_MD_TEMPLATE,
      description: "Project-specific test conventions for AI skill",
    },
    {
      path: "local/README.md",
      content: LOCAL_README,
      description: "Personal explore directory (gitignored)",
    },
  ];

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

    console.log(`${colors.bold}Next steps:${colors.reset}`);
    console.log(`\n  Connect AI  ${colors.dim}(run once)${colors.reset}`);
    console.log(`    ${colors.bold}${colors.cyan}npx skills add glubean/skill${colors.reset}`);
    console.log(`    ${colors.bold}${colors.cyan}npx add-mcp "npx -y @glubean/mcp@latest"${colors.reset}\n`);
    console.log(
      `  1. Run ${colors.cyan}npm test${colors.reset} to run all tests in tests/`,
    );
    console.log(
      `  2. Run ${colors.cyan}npm run explore${colors.reset} to run explore/ tests`,
    );
    console.log(
      `  3. Drop your OpenAPI spec in ${colors.cyan}context/${colors.reset} for AI-assisted test writing`,
    );
    console.log(
      `\n  ${colors.dim}Tip: install CLI globally for convenience:${colors.reset} ${colors.cyan}npm install -g @glubean/cli${colors.reset}\n`,
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

const PRODUCT_README = `# Product Intent

This directory holds the upstream business requirements, user stories, and
acceptance criteria that drive the contracts in \`contracts/\`.

The agent reads these files to understand what the API should do.
Write them in whatever format your team uses — markdown, bullet lists,
copy-pasted issue descriptions, or structured PRDs.

## Tips

- One file per feature or resource (e.g. \`coupons.md\`, \`auth.md\`)
- Include expected error cases and edge conditions
- Reference specific status codes and field names when you know them
- When requirements conflict, note both versions — the agent will escalate
`;

const CONTRACTS_README = `# Contracts

Executable API contracts — the source of truth for how the API should behave.

Files here are Glubean tests written in contract-first style:
- \`ctx.validate(zodSchema)\` defines response shape contracts
- \`.step()\` chains define cross-endpoint workflow contracts
- \`ctx.expect\` assertions define key business values

These contracts are NOT exploratory tests. They define the target behavior.

## Lifecycle

1. Draft: agent writes contract from product intent
2. Review: human confirms the contract matches intent
3. Red: implementation does not satisfy the contract yet
4. Green: implementation passes all contracts
5. Promote: stable contracts move to \`tests/\` for regression

## Rules

- Do not modify contracts to make failing implementations pass
- Fix the implementation, not the contract
- Only change a contract when the business requirement changes
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
        test: "glubean run --config ci-config/default.yaml",
        "test:ci": "glubean run --config ci-config/ci.yaml",
        explore: "glubean run --config ci-config/explore.yaml",
        scan: "glubean scan",
      },
      dependencies: {
        "@glubean/sdk": sdkVersion,
        zod: "^4.0.0",
      },
    },
    null,
    2,
  ) + "\n";

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
      path: "product/README.md",
      content: PRODUCT_README,
      description: "Product intent directory",
    },
    {
      path: "contracts/README.md",
      content: CONTRACTS_README,
      description: "Executable contracts directory",
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
      path: "ci-config/default.yaml",
      content: () => readCliTemplate("ci-config/default.yaml"),
      description: "Default run config",
    },
    {
      path: "ci-config/ci.yaml",
      content: () => readCliTemplate("ci-config/ci.yaml"),
      description: "CI run config",
    },
    {
      path: "ci-config/explore.yaml",
      content: () => readCliTemplate("ci-config/explore.yaml"),
      description: "Explore run config",
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
      `  1. Write your API requirements in ${colors.cyan}product/${colors.reset}`,
    );
    console.log(
      `  2. Ask your AI agent to write contracts in ${colors.cyan}contracts/${colors.reset}`,
    );
    console.log(
      `  3. Implement the API, then run ${colors.cyan}npm run contract:run${colors.reset}`,
    );
    console.log(
      `  4. Iterate until green, then promote to ${colors.cyan}tests/${colors.reset}\n`,
    );
  }
}
