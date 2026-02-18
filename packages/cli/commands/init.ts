/**
 * Init command - scaffolds a new Glubean test project with a 3-step wizard.
 *
 * Step 1: Project Type — Standard or Playground
 * Step 2: API Setup — Base URL and optional OpenAPI spec
 * Step 3: Git & CI — Auto-detect/init git, hooks, GitHub Actions
 */

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
  return Deno.stdin.isTerminal();
}

/**
 * Read a line from stdin. Works correctly with both TTY and piped input.
 * Uses Deno's built-in prompt() for TTY (shows prompt text, handles backspace).
 * Falls back to manual stdin read for piped input (prompt() ignores piped data).
 */
function readLine(message: string): string {
  if (Deno.stdin.isTerminal()) {
    return prompt(message) ?? "";
  }
  // Piped stdin: write prompt to stdout, read one byte at a time until newline
  const encoder = new TextEncoder();
  Deno.stdout.writeSync(encoder.encode(message + " "));
  const buf = new Uint8Array(1);
  const line: number[] = [];
  while (true) {
    const n = Deno.stdin.readSync(buf);
    if (n === null || n === 0) break; // EOF
    if (buf[0] === 0x0a) break; // newline — done
    if (buf[0] !== 0x0d) line.push(buf[0]); // skip CR
  }
  Deno.stdout.writeSync(encoder.encode("\n"));
  return new TextDecoder().decode(new Uint8Array(line));
}

function promptYesNo(question: string, defaultYes: boolean): boolean {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const input = readLine(`${question} ${hint}`);
    const normalized = input.trim().toLowerCase();
    if (!normalized) return defaultYes;
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
  }
}

function promptChoice(
  question: string,
  options: { key: string; label: string; desc: string }[],
  defaultKey: string,
): string {
  console.log(`  ${question}\n`);
  for (const opt of options) {
    const marker = opt.key === defaultKey ? `${colors.green}❯${colors.reset}` : " ";
    console.log(
      `  ${marker} ${colors.bold}${opt.key}.${colors.reset} ${opt.label}  ${colors.dim}${opt.desc}${colors.reset}`,
    );
  }
  console.log();

  while (true) {
    const input = readLine(
      `  Enter choice ${colors.dim}[${defaultKey}]${colors.reset}`,
    );
    const trimmed = input.trim();
    if (!trimmed) return defaultKey;
    const match = options.find((o) => o.key === trimmed);
    if (match) return match.key;
  }
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCliTemplate(relativePath: string): Promise<string> {
  const url = new URL(`../templates/${relativePath}`, import.meta.url);
  if (url.protocol === "file:") {
    return await Deno.readTextFile(url);
  }
  // When installed from JSR, import.meta.url is https:// — use fetch
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to load template ${relativePath} (HTTP ${resp.status})`,
    );
  }
  return await resp.text();
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

const SDK_VERSION = "^0.11.0";

function makeDenoJson(_baseUrl: string): string {
  return (
    JSON.stringify(
      {
        imports: {
          "@glubean/sdk": `jsr:@glubean/sdk@${SDK_VERSION}`,
        },
        tasks: {
          test: "deno run -A jsr:@glubean/cli run",
          "test:verbose": "deno run -A jsr:@glubean/cli run --verbose",
          "test:staging": "deno run -A jsr:@glubean/cli run --env-file .env.staging",
          "test:log": "deno run -A jsr:@glubean/cli run --log-file",
          explore: "deno run -A jsr:@glubean/cli run --explore",
          "explore:verbose": "deno run -A jsr:@glubean/cli run --explore --verbose",
          scan: "deno run -A jsr:@glubean/cli scan",
          "validate-metadata": "deno run -A jsr:@glubean/cli validate-metadata",
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
  // Derive staging URL: replace the host or just show a placeholder
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

# Deno
.deno/

# Glubean internal
.glubean/
`;

// SAMPLE_TEST removed — now loaded from templates/demo.test.ts

const PRE_COMMIT_HOOK = `#!/bin/sh
set -e

deno run -A jsr:@glubean/cli scan

if [ -n "$(git diff --name-only -- metadata.json)" ]; then
  echo "metadata.json updated. Please git add metadata.json"
  exit 1
fi
`;

const PRE_PUSH_HOOK = `#!/bin/sh
set -e

deno run -A jsr:@glubean/cli validate-metadata
`;

const GITHUB_ACTION = `name: Glubean Metadata

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
      - uses: denoland/setup-deno@v1
        with:
          deno-version: v2.x
      - name: Generate metadata.json
        run: deno run -A jsr:@glubean/cli scan
      - name: Verify metadata.json
        run: git diff --exit-code metadata.json
`;

// ---------------------------------------------------------------------------
// Templates — Playground
// ---------------------------------------------------------------------------

const PLAYGROUND_DENO_JSON = `{
  "imports": {
    "@glubean/sdk": "jsr:@glubean/sdk@${SDK_VERSION}"
  },
  "tasks": {
    "test": "deno run -A jsr:@glubean/cli run",
    "explore": "deno run -A jsr:@glubean/cli run --explore",
    "scan": "deno run -A jsr:@glubean/cli scan",
    "validate-metadata": "deno run -A jsr:@glubean/cli validate-metadata"
  },
  "glubean": {
    "run": {
      "verbose": true,
      "pretty": true,
      "emitFullTrace": false,
      "testDir": "./tests",
      "exploreDir": "./explore"
    },
    "redaction": {
      "replacementFormat": "simple"
    }
  }
}
`;

const PLAYGROUND_ENV = `# DummyJSON API - no auth required for basic endpoints
BASE_URL=https://dummyjson.com
`;

const PLAYGROUND_ENV_SECRETS = `# DummyJSON test credentials (used by auth exercises)
# These are DummyJSON's built-in test accounts (public, safe to use).
USERNAME=emilys
PASSWORD=emilyspass
`;

const PLAYGROUND_ENV_SECRETS_EXAMPLE = `# DummyJSON test credentials (used by auth exercises)
# Copy this file to .env.secrets and fill in the values:
#   cp .env.secrets.example .env.secrets
#
# These are DummyJSON's built-in test accounts (public, safe to use).
USERNAME=emilys
PASSWORD=emilyspass
`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InitOptions {
  playground?: boolean;
  hooks?: boolean;
  githubActions?: boolean;
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
  const forceInteractive = Deno.env.get("GLUBEAN_FORCE_INTERACTIVE") === "1";
  if (interactive && !isInteractive() && !forceInteractive) {
    console.error(
      "Interactive init requires a TTY. Use --no-interactive and pass --hooks/--github-actions flags.",
    );
    Deno.exit(1);
  }

  // ── Step 1/3 — Project Type ──────────────────────────────────────────────

  let isPlayground = options.playground ?? false;

  if (interactive && !options.playground) {
    console.log(
      `${colors.dim}━━━ Step 1/3 — Project Type ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );
    const choice = promptChoice(
      "What would you like to create?",
      [
        {
          key: "1",
          label: "New test project",
          desc: "Fresh API test project with sample tests",
        },
        {
          key: "2",
          label: "Playground",
          desc: "Learn Glubean + AI in 30 min (guided exercises)",
        },
      ],
      "1",
    );
    isPlayground = choice === "2";
  }

  if (isPlayground) {
    await initPlayground(options.overwrite ?? false);
    return;
  }

  // ── Step 2/3 — API Setup ─────────────────────────────────────────────────

  let baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (interactive) {
    console.log(
      `\n${colors.dim}━━━ Step 2/3 — API Setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );

    const urlInput = readLine(
      `  Your API base URL ${colors.dim}(Enter for ${DEFAULT_BASE_URL})${colors.reset}`,
    );
    if (urlInput.trim()) {
      baseUrl = urlInput.trim();
    }
    console.log(
      `\n  ${colors.green}✓${colors.reset} Base URL: ${colors.cyan}${baseUrl}${colors.reset}`,
    );
  }

  // ── Step 3/3 — Git & CI ──────────────────────────────────────────────────

  let enableHooks = options.hooks;
  let enableActions = options.githubActions;
  let hasGit = await fileExists(".git");

  if (interactive) {
    console.log(
      `\n${colors.dim}━━━ Step 3/3 — Git & CI ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
    );

    if (!hasGit) {
      console.log(
        `  ${colors.yellow}⚠${colors.reset} No Git repository detected\n`,
      );
      const initGit = promptYesNo(
        "  Initialize Git repository? (recommended — enables hooks, CI, and glubean diff)",
        true,
      );
      if (initGit) {
        const cmd = new Deno.Command("git", {
          args: ["init"],
          stdout: "piped",
          stderr: "piped",
        });
        const result = await cmd.output();
        if (result.success) {
          hasGit = true;
          console.log(
            `\n  ${colors.green}✓${colors.reset} Git repository initialized\n`,
          );
        } else {
          console.log(
            `\n  ${colors.yellow}⚠${colors.reset} Failed to initialize Git — skipping hooks and actions\n`,
          );
        }
      } else {
        console.log(
          `\n  ${colors.dim}Skipping Git hooks and GitHub Actions${colors.reset}`,
        );
        console.log(
          `  ${colors.dim}Run "git init && glubean init --hooks --github-actions" later${colors.reset}\n`,
        );
      }
    } else {
      console.log(
        `  ${colors.green}✓${colors.reset} Git repository detected\n`,
      );
    }

    if (hasGit) {
      if (enableHooks === undefined) {
        enableHooks = promptYesNo(
          "  Enable Git hooks? (auto-updates metadata.json on commit)",
          true,
        );
      }
      if (enableActions === undefined) {
        enableActions = promptYesNo(
          "  Enable GitHub Actions? (CI verifies metadata.json on PR)",
          true,
        );
      }
    } else {
      enableHooks = false;
      enableActions = false;
    }
  } else {
    // Non-interactive mode
    if (enableHooks && !hasGit) {
      console.error(
        "Error: --hooks requires a Git repository. Run `git init` first.",
      );
      Deno.exit(1);
    }
    if (enableHooks === undefined) enableHooks = false;
    if (enableActions === undefined) enableActions = false;
  }

  // ── Create files ─────────────────────────────────────────────────────────

  console.log(
    `\n${colors.dim}━━━ Creating project ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "deno.json",
      content: makeDenoJson(baseUrl),
      description: "Deno config with tasks",
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
      content: () => readCliTemplate("demo.test.ts"),
      description: "Demo tests (rich output for dashboard preview)",
    },
    {
      path: "tests/data-driven.test.ts",
      content: () => readCliTemplate("data-driven.test.ts"),
      description: "Data-driven test examples (JSON, CSV, YAML)",
    },
    {
      path: "tests/pick.test.ts",
      content: () => readCliTemplate("pick.test.ts"),
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
      content: () => readCliTemplate("explore-api.test.ts"),
      description: "Explore scratchpad (quick API calls)",
    },
    {
      path: "AGENTS.md",
      content: () => readCliTemplate("AGENTS.md"),
      description: "AI agent guidelines",
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
    files.push({
      path: ".github/workflows/glubean-metadata.yml",
      content: GITHUB_ACTION,
      description: "GitHub Actions metadata workflow",
    });
  }

  let created = 0;
  let skipped = 0;
  let overwritten = 0;

  const shouldOverwrite = (path: string): boolean => {
    if (options.overwrite) return true;
    if (options.overwriteHooks && path.startsWith(".git/hooks/")) return true;
    if (
      options.overwriteActions &&
      path === ".github/workflows/glubean-metadata.yml"
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
      await Deno.mkdir(parentDir, { recursive: true });
    }
    const content = await resolveContent(file.content);
    await Deno.writeTextFile(file.path, content);
    if (file.path.startsWith(".git/hooks/")) {
      try {
        await Deno.chmod(file.path, 0o755);
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
    console.log(`${colors.bold}Next steps:${colors.reset}`);
    console.log(
      `  1. Run ${colors.cyan}deno task test${colors.reset} to run all tests in tests/`,
    );
    console.log(
      `  2. Run ${colors.cyan}deno task test:verbose${colors.reset} for detailed output`,
    );
    console.log(
      `  3. Run ${colors.cyan}deno task explore${colors.reset} to run explore/ tests`,
    );
    console.log(
      `  4. Read ${colors.cyan}AGENTS.md${colors.reset} for AI agent integration guide`,
    );
    console.log(
      `  5. Run ${colors.cyan}glubean context${colors.reset} to generate AI context\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Playground init
// ---------------------------------------------------------------------------

async function initPlayground(overwrite: boolean): Promise<void> {
  console.log(
    `${colors.dim}  DummyJSON API — learn Glubean + AI in 30 minutes${colors.reset}\n`,
  );

  const files: FileEntry[] = [
    {
      path: "deno.json",
      content: PLAYGROUND_DENO_JSON,
      description: "Deno config with playground tasks",
    },
    {
      path: ".env",
      content: PLAYGROUND_ENV,
      description: "DummyJSON base URL",
    },
    {
      path: ".env.secrets",
      content: PLAYGROUND_ENV_SECRETS,
      description: "DummyJSON test credentials",
    },
    {
      path: ".env.secrets.example",
      content: PLAYGROUND_ENV_SECRETS_EXAMPLE,
      description: "Secrets template (safe to commit)",
    },
    {
      path: ".gitignore",
      content: GITIGNORE,
      description: "Git ignore rules",
    },
    {
      path: "README.md",
      content: () => readCliTemplate("playground/README.md"),
      description: "Playground guide with 8 exercises",
    },
    {
      path: "API_REFERENCE.md",
      content: () => readCliTemplate("playground/API_REFERENCE.md"),
      description: "DummyJSON API reference for AI agents",
    },
    {
      path: "tests/smoke.test.ts",
      content: () => readCliTemplate("playground/smoke.test.ts"),
      description: "Smoke test (pre-written)",
    },
    {
      path: "explore/api.test.ts",
      content: () => readCliTemplate("explore-api.test.ts"),
      description: "Explore scratchpad (quick API calls)",
    },
    {
      path: "AGENTS.md",
      content: () => readCliTemplate("AGENTS.md"),
      description: "AI agent guidelines",
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
      await Deno.mkdir(parentDir, { recursive: true });
    }
    const content = await resolveContent(file.content);
    await Deno.writeTextFile(file.path, content);

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
    console.log(`${colors.bold}Next steps:${colors.reset}`);
    console.log(
      `  1. Run ${colors.cyan}deno task test${colors.reset} to verify setup`,
    );
    console.log(
      `  2. Open ${colors.cyan}README.md${colors.reset} for the exercise guide`,
    );
    console.log(`  3. Copy the first exercise prompt into your AI agent`);
    console.log(
      `  4. Watch the AI write, run, fail, and fix — that's the Glubean loop!\n`,
    );
  }
}
