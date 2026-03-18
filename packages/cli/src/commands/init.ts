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
import { confirm, input, select } from "@inquirer/prompts";
import { CLI_VERSION } from "../version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
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
          test: "glubean run",
          "test:verbose": "glubean run --verbose",
          "test:staging": "glubean run --env-file .env.staging",
          "test:log": "glubean run --log-file",
          "test:ci": "glubean run --ci --result-json",
          explore: "glubean run --explore",
          "explore:verbose": "glubean run --explore --verbose",
          scan: "glubean scan",
          "validate-metadata": "glubean validate-metadata",
        },
        dependencies: {
          "@glubean/sdk": SDK_VERSION,
        },
        glubean: {
          run: {
            verbose: false,
            pretty: true,
            emitFullTrace: false,
            testDir: "./tests",
            exploreDir: "./explore",
          },
          redaction: {
            replacementFormat: "simple",
          },
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

# Log files
*.log

# Result files (generated by glubean run)
*.result.json

# Node
node_modules/

# Glubean internal
.glubean/
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
// Templates — Minimal project
// ---------------------------------------------------------------------------

function makeMinimalPackageJson(): string {
  return JSON.stringify(
    {
      name: "my-glubean-tests",
      version: "0.1.0",
      type: "module",
      scripts: {
        test: "glubean run",
        "test:verbose": "glubean run --verbose",
        "test:staging": "glubean run --env-file .env.staging",
        "test:ci": "glubean run --ci --result-json",
        explore: "glubean run --explore --verbose",
        scan: "glubean scan",
      },
      dependencies: {
        "@glubean/sdk": SDK_VERSION,
      },
      glubean: {
        run: {
          verbose: true,
          pretty: true,
          testDir: "./tests",
          exploreDir: "./explore",
        },
      },
    },
    null,
    2,
  ) + "\n";
}

const MINIMAL_ENV = `# Environment variables
# Tip: switch environments from the VS Code status bar — one click to toggle
# between default, staging, and any custom .env.* file.
BASE_URL=https://dummyjson.com
`;

const MINIMAL_ENV_SECRETS = `# Secrets (add this file to .gitignore)
# DummyJSON test credentials (public, safe to use)
USERNAME=emilys
PASSWORD=emilyspass
`;

const MINIMAL_ENV_STAGING = `# Staging environment variables
# Usage: glubean run --env-file .env.staging
# Tip: or switch to "staging" from the VS Code status bar — no CLI flags needed.
BASE_URL=https://staging.dummyjson.com
`;

const MINIMAL_ENV_STAGING_SECRETS = `# Staging secrets (gitignored)
# Usage: auto-loaded when --env-file .env.staging is used
# API_KEY=your-staging-api-key
USERNAME=
PASSWORD=
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

export interface InitOptions {
  minimal?: boolean;
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

  // ── Step 1/3 — Project Type ──────────────────────────────────────────────

  let isMinimal = options.minimal ?? false;

  if (interactive && !options.minimal) {
    console.log(
      `${colors.dim}━━━ Step 1/3 — Project Type ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );
    const choice = await promptChoice(
      "What would you like to create?",
      [
        {
          key: "1",
          label: "Best Practice",
          desc: "Full project with tests, CI, multi-env, and examples",
        },
        {
          key: "2",
          label: "Minimal",
          desc: "Quick start — explore folder with GET, POST, and pick examples",
        },
      ],
      "1",
    );
    isMinimal = choice === "2";
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

  if (isMinimal) {
    await initMinimal(options.overwrite ?? false);
    return;
  }

  // ── Step 2/3 — API Setup ─────────────────────────────────────────────────

  let baseUrl = options.baseUrl ? validateBaseUrlOrExit(options.baseUrl, "--base-url") : DEFAULT_BASE_URL;

  if (interactive) {
    console.log(
      `\n${colors.dim}━━━ Step 2/3 — API Setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );

    if (useFancyPrompts()) {
      const urlInput = await input({
        message: "Your API base URL",
        default: DEFAULT_BASE_URL,
        validate: (value) => {
          if (!value.trim()) return true;
          const result = validateBaseUrl(value);
          return result.ok || result.reason;
        },
      });
      if (urlInput.trim() && urlInput !== DEFAULT_BASE_URL) {
        const validated = validateBaseUrl(urlInput);
        if (validated.ok) baseUrl = validated.value;
      }
    } else {
      while (true) {
        const urlInput = await readLine(
          `  Your API base URL ${colors.dim}(Enter for ${DEFAULT_BASE_URL})${colors.reset}`,
        );
        if (!urlInput.trim()) break;

        const validated = validateBaseUrl(urlInput);
        if (validated.ok) {
          baseUrl = validated.value;
          break;
        }

        console.log(
          `  ${colors.yellow}⚠${colors.reset} Invalid URL: ${validated.reason}`,
        );
        console.log(
          `  ${colors.dim}Try something like: https://api.example.com${colors.reset}\n`,
        );
      }
    }
    console.log(
      `\n  ${colors.green}✓${colors.reset} Base URL: ${colors.cyan}${baseUrl}${colors.reset}`,
    );
  }

  // ── Step 3/3 — AI Tools ─────────────────────────────────────────────────

  let enableAiTools = options.aiTools;
  let aiTarget: "claude-code" | "codex" | "cursor" | "skip" = "skip";

  if (interactive) {
    console.log(
      `\n${colors.dim}━━━ Step 3/3 — AI Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );

    if (enableAiTools === undefined) {
      enableAiTools = await promptYesNo(
        "Configure AI coding tool? (installs MCP server + test-writing skill)",
        true,
      );
    }

    if (enableAiTools) {
      const { select } = await import("@inquirer/prompts");
      aiTarget = await select({
        message: "Which AI tool do you use?",
        choices: [
          { name: "Claude Code", value: "claude-code" as const },
          { name: "Codex (OpenAI)", value: "codex" as const },
          { name: "Cursor", value: "cursor" as const },
          { name: "Skip for now", value: "skip" as const },
        ],
      });

      if (aiTarget !== "skip") {
        try {
          const { configMcpCommand } = await import("./config_mcp.js");
          const { configSkillCommand } = await import("./config_skill.js");
          await configMcpCommand({ target: aiTarget === "codex" ? "codex" : aiTarget });
          await configSkillCommand({ target: aiTarget });
        } catch (err) {
          console.log(
            `\n  ${colors.yellow}⚠${colors.reset} Failed to configure AI tools — run "glubean config mcp" and "glubean config skill" later\n`,
          );
        }
      }
    }
  } else {
    if (enableAiTools === undefined) enableAiTools = false;
  }

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
      path: "CLAUDE.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Claude Code, Cursor)",
    },
    {
      path: "AGENTS.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Codex, other agents)",
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
    console.log(
      `  1. Run ${colors.cyan}npm test${colors.reset} to run all tests in tests/`,
    );
    console.log(
      `  2. Run ${colors.cyan}npm run test:verbose${colors.reset} for detailed output`,
    );
    console.log(
      `  3. Run ${colors.cyan}npm run explore${colors.reset} to run explore/ tests`,
    );
    console.log(
      `  4. Keep ${colors.cyan}CLAUDE.md${colors.reset} or ${colors.cyan}AGENTS.md${colors.reset} — delete whichever you don't need`,
    );
    console.log(
      `  5. Drop your OpenAPI spec in ${colors.cyan}context/${colors.reset} for AI-assisted test writing`,
    );
    console.log(
      `\n  ${colors.dim}Tip: install CLI globally for convenience:${colors.reset} ${colors.cyan}npm install -g @glubean/cli${colors.reset}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Minimal init
// ---------------------------------------------------------------------------

async function initMinimal(overwrite: boolean): Promise<void> {
  console.log(
    `${colors.dim}  Quick start — explore APIs with GET, POST, and pick examples${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "package.json",
      content: makeMinimalPackageJson(),
      description: "Package config with explore scripts",
    },
    {
      path: ".env",
      content: MINIMAL_ENV,
      description: "Environment variables",
    },
    {
      path: ".env.secrets",
      content: MINIMAL_ENV_SECRETS,
      description: "Secret variables (placeholder)",
    },
    {
      path: ".env.staging",
      content: MINIMAL_ENV_STAGING,
      description: "Staging environment variables",
    },
    {
      path: ".env.staging.secrets",
      content: MINIMAL_ENV_STAGING_SECRETS,
      description: "Staging secret variables",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "README.md",
      content: () => readCliTemplate("minimal/README.md"),
      description: "Project README",
    },
    {
      path: "tests/demo.test.ts",
      content: () => readCliTemplate("demo.test.ts.tpl"),
      description: "Demo tests (GET, POST, auth flow, pagination)",
    },
    {
      path: "explore/api.test.ts",
      content: () => readCliTemplate("minimal-api.test.ts.tpl"),
      description: "GET and POST examples",
    },
    {
      path: "explore/search.test.ts",
      content: () => readCliTemplate("minimal-search.test.ts.tpl"),
      description: "Parameterized search with test.pick",
    },
    {
      path: "explore/auth.test.ts",
      content: () => readCliTemplate("minimal-auth.test.ts.tpl"),
      description: "Multi-step auth flow (login → profile)",
    },
    {
      path: "data/search-examples.json",
      content: () => readCliTemplate("data/search-examples.json"),
      description: "Search parameters for pick examples",
    },
    {
      path: "CLAUDE.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Claude Code, Cursor)",
    },
    {
      path: "AGENTS.md",
      content: () => readCliTemplate("AI-INSTRUCTIONS.md"),
      description: "AI instructions (Codex, other agents)",
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
    console.log(
      `  1. Run ${colors.cyan}npm run explore${colors.reset} to run all explore tests`,
    );
    console.log(
      `  2. Open ${colors.cyan}explore/api.test.ts${colors.reset} — GET and POST basics`,
    );
    console.log(
      `  3. Open ${colors.cyan}explore/search.test.ts${colors.reset} — pick examples with external data`,
    );
    console.log(
      `  4. Open ${colors.cyan}explore/auth.test.ts${colors.reset} — multi-step flow with state`,
    );
    console.log(
      `  5. Read ${colors.cyan}README.md${colors.reset} for links and next steps\n`,
    );
  }
}
