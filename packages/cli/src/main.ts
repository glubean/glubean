/**
 * Glubean CLI - Main entry point
 *
 * Uses Commander.js for structured command handling with automatic help
 * generation, argument validation, and shell completions.
 */

// Support running from outside workspace (e.g. shell alias with GLUBEAN_CWD)
const _cwd = process.env["GLUBEAN_CWD"];
if (_cwd) process.chdir(_cwd);

import { Command } from "commander";
import { CLI_VERSION } from "./version.js";
import { loadConfig } from "./lib/config.js";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { scanCommand } from "./commands/scan.js";
import { validateMetadataCommand } from "./commands/validate_metadata.js";
import { loginCommand } from "./commands/login.js";
import { patchCommand } from "./commands/patch.js";
import { specSplitCommand } from "./commands/spec_split.js";
import { redactCommand } from "./commands/redact.js";
import { configMcpCommand } from "./commands/config_mcp.js";

import { envShowCommand, envUseCommand, envResetCommand, envListCommand } from "./commands/env.js";
import { abortUpdateCheck, checkForUpdates } from "./update_check.js";

const program = new Command();

program
  .name("glubean")
  .alias("gb")
  .version(CLI_VERSION)
  .description("Glubean CLI - Run and sync API tests from the command line")
  .option("--no-update-check", "Skip update check");

// ─────────────────────────────────────────────────────────────────────────────
// init command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize a new test project (interactive wizard)")
  .option("--minimal", "Scaffold minimal explore-only project (GET, POST, pick)")
  .option("--ai-tools", "Configure MCP server + AI skill for your editor")
  .option("--hooks", "Install git hooks (pre-commit, pre-push)")
  .option("--github-actions", "Scaffold GitHub Actions workflow")
  .option("--base-url <url>", "API base URL for .env")
  .option("--no-interactive", "Disable prompts (use with flags)")
  .option("--overwrite", "Overwrite existing files (dangerous)")
  .option("--overwrite-hooks", "Overwrite existing .git/hooks files")
  .option("--overwrite-actions", "Overwrite GitHub Actions workflow")
  .action(async (options) => {
    await initCommand({
      minimal: options.minimal,
      aiTools: options.aiTools,
      hooks: options.hooks,
      githubActions: options.githubActions,
      baseUrl: options.baseUrl,
      interactive: options.interactive,
      overwrite: options.overwrite,
      overwriteHooks: options.overwriteHooks,
      overwriteActions: options.overwriteActions,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// run command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("run [target]")
  .description("Run tests from a file, directory, or glob pattern (defaults to testDir)")
  .option("--explore", "Run explore tests (from exploreDir instead of testDir)")
  .option("-f, --filter <pattern>", "Run only tests matching pattern (name or id substring)")
  .option("-t, --tag <tag>", "Run only tests with matching tag (comma-separated or repeatable)", collect, [])
  .option("--tag-mode <mode>", 'Tag match logic: "or" (any tag) or "and" (all tags)', "or")
  .option("--env-file <path>", "Path to .env file (default: .env if it exists)")
  .option("-l, --log-file", "Write logs to file (<testfile>.log)")
  .option("--pretty", "Pretty-print JSON in log file (2-space indent)")
  .option("--verbose", "Show all output (traces, assertions) in console")
  .option("--fail-fast", "Stop on first test failure")
  .option("--fail-after <count>", "Stop after N test failures")
  .option("--result-json [path]", "Write structured results to .result.json (or custom path)")
  .option("--emit-full-trace", "Include full request/response headers and bodies in HTTP traces")
  .option("--infer-schema", "Infer JSON Schema from response bodies in traces")
  .option("--truncate-arrays", "Always truncate arrays in trace bodies for AI-friendly output")
  .option("--config <paths>", "Config file(s), comma-separated or repeatable", collect, [])
  .option("--pick <keys>", "Select specific test.pick example(s) by key (comma-separated)")
  .option("--inspect-brk [port]", "Enable V8 Inspector for debugging (pauses until debugger attaches)")
  .option("--reporter <format>", 'Output format: "junit" or "junit:/path/to/output.xml"')
  .option("--trace-limit <count>", "Max trace files to keep per test (default: 20)")
  .option("--ci", "CI mode: enables --fail-fast and --reporter junit")
  .option("--no-session", "Skip session setup/teardown")
  .option("-M, --meta <key=value>", "Custom run metadata (repeatable)", collect, [])
  .option("--upload", "Upload run results and artifacts to Glubean Cloud")
  .option("--project <id>", "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)")
  .option("--token <token>", "Auth token for cloud upload (or GLUBEAN_TOKEN env)")
  .option("--api-url <url>", "Glubean API server URL")
  .action(async (target, options) => {
    // Flatten --config values
    const configFiles = options.config && options.config.length > 0
      ? (options.config as string[]).flatMap((v: string) =>
        v.split(",").map((s: string) => s.trim()).filter(Boolean)
      )
      : undefined;

    // Resolve default target from config when not explicitly provided
    let resolvedTarget = target;
    if (!resolvedTarget) {
      const config = await loadConfig(process.cwd(), configFiles);
      resolvedTarget = options.explore ? config.run.exploreDir : config.run.testDir;
    }

    // --ci implies --fail-fast and --reporter junit
    const isCi = options.ci === true;
    const failFast = options.failFast || isCi;
    let reporter = options.reporter;
    let reporterPath: string | undefined;
    if (!reporter && isCi) {
      reporter = "junit";
    }
    if (reporter && reporter.startsWith("junit:")) {
      reporterPath = reporter.slice("junit:".length);
      reporter = "junit";
    }

    const resultJson = options.resultJson;

    await runCommand(resolvedTarget, {
      filter: options.filter,
      pick: options.pick,
      tags: options.tag?.flatMap((t: string) => t.split(",").map((s: string) => s.trim()).filter(Boolean)),
      tagMode: options.tagMode as "or" | "and",
      envFile: options.envFile,
      logFile: options.logFile,
      pretty: options.pretty,
      verbose: options.verbose,
      failFast,
      failAfter: options.failAfter ? parseInt(options.failAfter, 10) : undefined,
      resultJson,
      emitFullTrace: options.emitFullTrace,
      inferSchema: options.inferSchema,
      truncateArrays: options.truncateArrays,
      configFiles,
      inspectBrk: options.inspectBrk,
      reporter,
      reporterPath,
      traceLimit: options.traceLimit ? parseInt(options.traceLimit, 10) : undefined,
      noSession: options.noSession,
      meta: options.meta?.length
        ? (options.meta as string[]).reduce((acc: Record<string, string>, item: string) => {
            const eq = item.indexOf("=");
            if (eq > 0) acc[item.slice(0, eq)] = item.slice(eq + 1);
            return acc;
          }, {})
        : undefined,
      upload: options.upload,
      project: options.project,
      token: options.token,
      apiUrl: options.apiUrl,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// scan command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("scan")
  .description("Generate metadata.json from a directory")
  .option("-d, --dir <path>", "Directory to scan", ".")
  .option("--out <path>", "Output path for metadata.json")
  .action(async (options) => {
    await scanCommand({
      dir: options.dir,
      output: options.out,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// validate-metadata command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("validate-metadata")
  .description("Validate metadata.json against local files")
  .option("-d, --dir <path>", "Project root", ".")
  .option("--metadata <path>", "Path to metadata.json")
  .action(async (options) => {
    await validateMetadataCommand({
      dir: options.dir,
      metadata: options.metadata,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// login command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Authenticate with Glubean Cloud")
  .option("--token <token>", "Auth token (skip interactive prompt)")
  .option("--project <id>", "Default project ID")
  .option("--api-url <url>", "API server URL")
  .action(async (options) => {
    await loginCommand({
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// patch command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("patch <spec>")
  .description("Merge an OpenAPI spec with its .patch.yaml and write the complete spec")
  .option("--patch <file>", "Path to patch file (auto-discovered if omitted)")
  .option("-o, --output <file>", "Output file path (default: <name>.patched.json)")
  .option("--stdout", "Write to stdout instead of file")
  .option("--format <fmt>", 'Output format: "json" or "yaml" (default: same as input)')
  .action(async (spec, options) => {
    await patchCommand(spec, {
      patch: options.patch,
      output: options.output,
      stdout: options.stdout,
      format: options.format as "json" | "yaml" | undefined,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// spec command (with subcommands)
// ─────────────────────────────────────────────────────────────────────────────
const specCmd = program
  .command("spec")
  .description("OpenAPI spec tools");

specCmd
  .command("split <spec>")
  .description("Dereference $refs and split spec into per-endpoint files for AI")
  .option("-o, --output <dir>", "Output directory (default: <name>-endpoints/ next to spec)")
  .action(async (spec, options) => {
    await specSplitCommand(spec, { output: options.output });
  });

// ─────────────────────────────────────────────────────────────────────────────
// redact command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("redact")
  .description("Preview redaction on a result JSON file")
  .option("-i, --input <path>", "Input result JSON file (default: glubean-run.result.json)")
  .option("-o, --output <path>", "Output file path (default: <input>.redacted.json)")
  .option("--stdout", "Write redacted JSON to stdout")
  .option("--config <paths>", "Config file(s), comma-separated or repeatable", collect, [])
  .action(async (options) => {
    const configFiles = options.config && options.config.length > 0
      ? (options.config as string[]).flatMap((v: string) =>
        v.split(",").map((s: string) => s.trim()).filter(Boolean)
      )
      : undefined;
    await redactCommand({
      input: options.input,
      output: options.output,
      stdout: options.stdout,
      config: configFiles,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// config command (with subcommands)
// ─────────────────────────────────────────────────────────────────────────────
const configCmd = program
  .command("config")
  .description("Configuration tools");

configCmd
  .command("mcp")
  .description("Configure MCP server for AI coding tools (Claude Code, Cursor, Windsurf)")
  .option("--target <tool>", "AI tool: claude-code, codex, cursor, or windsurf")
  .option("--remove", "Remove MCP server configuration")
  .action(async (options) => {
    await configMcpCommand({
      target: options.target as "claude-code" | "cursor" | "windsurf" | undefined,
      remove: options.remove,
    });
  });

// `config skill` and `docs pull` removed — use `npx skills add glubean/skill` instead.

// ─────────────────────────────────────────────────────────────────────────────
// env command (with subcommands)
// ─────────────────────────────────────────────────────────────────────────────
const envCmd = program
  .command("env")
  .description("Manage active environment for test runs")
  .action(async () => {
    await envShowCommand();
  });

envCmd
  .command("use <name>")
  .description("Set active environment (e.g. staging, production)")
  .action(async (name) => {
    await envUseCommand(name);
  });

envCmd
  .command("reset")
  .description("Clear active environment (use default .env)")
  .action(async () => {
    await envResetCommand();
  });

envCmd
  .command("list")
  .alias("ls")
  .description("List available .env.<name> files")
  .action(async () => {
    await envListCommand();
  });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Collect repeated options into an array (Commander.js pattern) */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

// Check for updates (non-blocking)
if (!process.argv.includes("--no-update-check")) {
  checkForUpdates(CLI_VERSION).catch(() => {});
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("An unexpected error occurred");
  }
  process.exit(1);
} finally {
  abortUpdateCheck();
}

// Export CLI version for programmatic access
export { CLI_VERSION } from "./version.js";
