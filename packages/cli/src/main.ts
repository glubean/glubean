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
import {
  loadConfig,
  loadProjectConfigV1,
  resolveRunPlan,
  GlubeanConfigError,
  type CliProfileOverrides,
  type ResolvedRunPlan,
} from "./lib/config.js";
import { formatResolvedPlan } from "./lib/print-plan.js";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { scanCommand } from "./commands/scan.js";
import { validateMetadataCommand } from "./commands/validate_metadata.js";
import { loginCommand } from "./commands/login.js";
import { patchCommand } from "./commands/patch.js";
import { specSplitCommand } from "./commands/spec_split.js";
import { redactCommand } from "./commands/redact.js";
import { configMcpCommand } from "./commands/config_mcp.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { migrateCommand } from "./commands/migrate.js";

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
  .description("Initialize a new Glubean project (interactive wizard)")
  .option("--contract-first", "Scaffold contract-first project (product/, contracts/, tests/)")
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
      contractFirst: options.contractFirst,
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
  .option("--profile <name>", "Use profile from glubean.yaml (Phase 1 first slice). When set, loads glubean.yaml + resolves the named profile; CLI flags still override profile values.")
  .option(
    "--suite <name>",
    "Run only the named suite from the profile. The name must already appear in `profile.suites`. (Single value only; multi-suite execution lands in a follow-up.)",
  )
  .option("-t, --tag <tag>", "Run only tests with matching tag (comma-separated or repeatable)", collect, [])
  .option("--tag-mode <mode>", 'Tag match logic: "or" (any tag) or "and" (all tags)', "or")
  .option("--exclude-tag <tag>", "Exclude tests with matching tag (comma-separated or repeatable; always OR-mode — any match drops the test)", collect, [])
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
  .option("--include-browser", "Include cases that require a browser (e.g., OAuth login)")
  .option("--include-out-of-band", "Include cases that require out-of-band channels (email, SMS)")
  .option("--include-opt-in", "Include opt-in cases (expensive, slow, or side-effect-producing)")
  .option("--no-session", "Skip session setup/teardown")
  .option("-M, --meta <key=value>", "Custom run metadata (repeatable)", collect, [])
  .option("--upload", "Upload run results and artifacts to Glubean Cloud")
  .option("--project <id>", "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)")
  .option("--token <token>", "Auth token for cloud upload (or GLUBEAN_TOKEN env)")
  .option("--api-url <url>", "Glubean API server URL")
  .option(
    "--input-json <value>",
    "Explicit case input as JSON literal or @path/to.json. Validated against the case's `needs` schema; runs raw (overlay skipped). Requires --filter to match exactly one testId.",
  )
  .option(
    "--bootstrap-json <value>",
    "Bootstrap params as JSON literal or @path/to.json. Validated against the overlay's `params` schema and passed to overlay's run(ctx, params). Requires --filter to match exactly one testId.",
  )
  .option(
    "--force-standalone",
    "DEBUG: bypass `runnability.requireAttachment` for the filtered case. Emits a runtime warning. Author-debug only.",
  )
  .action(async (target, options, cmd) => {
    // Flatten --config values
    const configFiles = options.config && options.config.length > 0
      ? (options.config as string[]).flatMap((v: string) =>
        v.split(",").map((s: string) => s.trim()).filter(Boolean)
      )
      : undefined;

    // --suite is a profile-mode-only override. Reject it without --profile
    // so the user sees the broader-than-expected run before it starts,
    // instead of silently ignoring the flag.
    if (options.suite && !options.profile) {
      console.error(
        `\x1b[31m--suite requires --profile (the suite name is looked up in ` +
          `the profile's \`suites:\` list).\x1b[0m`,
      );
      process.exit(1);
    }

    // ── Profile mode (Phase 1 first slice) ──────────────────────────────────
    // When --profile is given, load glubean.yaml, resolve the profile, then
    // build CliProfileOverrides from explicit CLI flags so they still beat
    // profile values. Suite expansion + selection/execution/reporters/upload
    // come from the plan.
    //
    // Multi-suite limitation (E1 scope): only single-suite profiles are
    // supported here. Multi-suite execution requires discovery alignment
    // (Phase 2) — the runner currently takes a single test target dir, not
    // an array. Profiles with len(suites) > 1 are rejected with a clear
    // error rather than silently running only the first suite.
    let resolvedPlan: ResolvedRunPlan | undefined;
    if (options.profile) {
      try {
        // Honor --config when combined with --profile (first --config wins;
        // multi-merge dropped per plan §"是否保留 --config"). Without this,
        // `--config ./ci/glubean.yaml` is silently ignored for profile mode.
        const profileConfigPath = configFiles && configFiles.length > 0
          ? configFiles[0]
          : undefined;
        const { config, configPath } = await loadProjectConfigV1(
          process.cwd(),
          profileConfigPath ? { configPath: profileConfigPath } : {},
        );
        // commander's getOptionValueSource returns "cli" only when user typed
        // the flag — otherwise "default" or undefined. Use this to detect
        // explicit overrides for fields where omitted ≠ a meaningful value.
        const cmdSrc = (name: string) =>
          (cmd as { getOptionValueSource?: (n: string) => string | undefined })
            .getOptionValueSource?.(name) === "cli";

        const explicitTags = options.tag && options.tag.length > 0
          ? (options.tag as string[]).flatMap((t) =>
              t.split(",").map((s) => s.trim()).filter(Boolean),
            )
          : undefined;
        const explicitExcludeTags = options.excludeTag && options.excludeTag.length > 0
          ? (options.excludeTag as string[]).flatMap((t) =>
              t.split(",").map((s) => s.trim()).filter(Boolean),
            )
          : undefined;
        // --suite override (Phase 3 task 2): single value. Multi-suite
        // execution isn't wired in yet, so accepting a list and then
        // hard-erroring on the multi-suite gate below would be a confusing
        // UX. Restrict to a single suite name and document it in --help.
        const explicitSuites = options.suite
          ? [(options.suite as string).trim()].filter(Boolean)
          : undefined;
        const cliOverrides: CliProfileOverrides = {
          suites: explicitSuites,
          tags: explicitTags,
          excludeTags: explicitExcludeTags,
          tagMode: cmdSrc("tagMode") ? (options.tagMode as "or" | "and") : undefined,
          filter: options.filter,
          pick: options.pick,
          envFile: options.envFile,
          failFast: cmdSrc("failFast") ? options.failFast : undefined,
          failAfter: options.failAfter ? parseInt(options.failAfter, 10) : undefined,
          includeBrowser: cmdSrc("includeBrowser") ? options.includeBrowser : undefined,
          includeOutOfBand: cmdSrc("includeOutOfBand") ? options.includeOutOfBand : undefined,
          includeOptIn: cmdSrc("includeOptIn") ? options.includeOptIn : undefined,
          emitFullTrace: cmdSrc("emitFullTrace") ? options.emitFullTrace : undefined,
          inferSchema: cmdSrc("inferSchema") ? options.inferSchema : undefined,
          truncateArrays: cmdSrc("truncateArrays") ? options.truncateArrays : undefined,
          uploadEnabled: cmdSrc("upload") ? options.upload : undefined,
        };
        resolvedPlan = resolveRunPlan(
          config,
          configPath,
          options.profile as string,
          cliOverrides,
        );
        if (resolvedPlan.suites.length !== 1) {
          if (resolvedPlan.suites.length === 0) {
            console.error(
              `\x1b[31mProfile "${resolvedPlan.profile}" has an empty \`suites\` ` +
                `list. Phase 1 first slice requires exactly one suite per ` +
                `profile (multi-suite execution lands in Phase 2).\x1b[0m`,
            );
          } else {
            console.error(
              `\x1b[31mProfile "${resolvedPlan.profile}" includes multiple suites ` +
                `(${resolvedPlan.suites.map((s) => s.name).join(", ")}). ` +
                `Multi-suite execution ships in Phase 2 (discovery alignment); ` +
                `for Phase 1 first slice, profiles must reference exactly one ` +
                `suite. Split into separate profiles for now.\x1b[0m`,
            );
          }
          process.exit(1);
        }
      } catch (err) {
        if (err instanceof GlubeanConfigError) {
          console.error(`\x1b[31m${err.message}\x1b[0m`);
          process.exit(1);
        }
        throw err;
      }
    }

    // Resolve default target from config when not explicitly provided
    let resolvedTarget = target;
    if (!resolvedTarget) {
      if (resolvedPlan && resolvedPlan.suites.length > 0) {
        // Profile mode: target = first suite's target. Single-suite is
        // enforced above (length !== 1 hard-errors), so suites[0] is the
        // only suite for the profile.
        //
        // KNOWN E1 GAP (deferred to Phase 2): `suite.kinds` is NOT enforced
        // at discovery time here. If the target directory contains mixed
        // file types (e.g. both `.test.ts` and `.contract.ts`), all are
        // currently discovered regardless of what `kinds:` declared. Phase 2
        // (discovery alignment) wires `kinds` through scanner / contract-
        // extraction. For E1 first slice, callers should organize a suite
        // to point at a target that only contains the declared kinds.
        resolvedTarget = resolvedPlan.suites[0].target;
      } else {
        const config = await loadConfig(process.cwd(), configFiles);
        resolvedTarget = options.explore ? config.run.exploreDir : config.run.testDir;
      }
    }

    // --ci implies --fail-fast and --reporter junit
    const isCi = options.ci === true;
    const failFast = (resolvedPlan?.execution.failFast ?? options.failFast) || isCi;
    let reporter = options.reporter;
    let reporterPath: string | undefined;
    if (!reporter && (isCi || resolvedPlan?.reporters.junit)) {
      reporter = "junit";
    }
    // Plan junit path is honored whether reporter was set by --ci or by plan.
    if (reporter === "junit" && !reporterPath && resolvedPlan?.reporters.junit) {
      reporterPath = resolvedPlan.reporters.junit;
    }
    if (reporter && reporter.startsWith("junit:")) {
      reporterPath = reporter.slice("junit:".length);
      reporter = "junit";
    }

    const resultJson = options.resultJson ?? resolvedPlan?.reporters.resultJson;

    // Helper: only treat CLI-supplied value as override when commander says
    // the user actually typed the flag. Otherwise plan wins.
    const cliSrc = (name: string): boolean =>
      (cmd as { getOptionValueSource?: (n: string) => string | undefined })
        .getOptionValueSource?.(name) === "cli";
    const cliTags = options.tag?.flatMap((t: string) =>
      t.split(",").map((s: string) => s.trim()).filter(Boolean),
    );
    const cliExcludeTags = options.excludeTag?.flatMap((t: string) =>
      t.split(",").map((s: string) => s.trim()).filter(Boolean),
    );

    // Phase 3 task 5 — print resolved plan AFTER all CLI overrides have
    // been merged so the printout is a verbatim record of what runs (and
    // not stale profile values that --result-json / --reporter / explicit
    // target overrode below). We build the printed view by overlaying the
    // post-override fields on top of `resolvedPlan`.
    //
    // Default-path placeholders: when the user enables `--reporter junit`
    // or `--result-json` without a path, runCommand picks a runtime
    // default (`glubean-run.junit.xml` / `glubean-run.result.json` for
    // multi-file, or `<testfile>.junit.xml` / `<testfile>.result.json`
    // for single-file). The exact default depends on test discovery
    // which hasn't run yet at print time — use a "<default>" hint so the
    // user sees that an artifact WILL be written.
    if (resolvedPlan) {
      const explicitTargetGiven = !!target && target !== resolvedPlan.suites[0]?.target;
      // junit reporter active iff `reporter === "junit"` after the
      // resolution above (either from CLI, profile, or implied by --ci).
      const junitActive = reporter === "junit";
      const printJunit = junitActive
        ? reporterPath ?? "<default: glubean-run.junit.xml or <testfile>.junit.xml>"
        : resolvedPlan.reporters.junit;
      // resultJson can be undefined / string path / true (flag with no value).
      const printResultJson =
        typeof resultJson === "string"
          ? resultJson
          : resultJson
            ? "<default: glubean-run.result.json or <testfile>.result.json>"
            : undefined;
      // Upload destination: when `--project <id>` is passed, the upload
      // routes to that project id, NOT the profile's `projectAlias`.
      // Reflect that override so the printed plan matches the actual
      // destination. Same enable-bit override for `--upload`.
      const overrideUpload = resolvedPlan.upload
        ? {
            ...resolvedPlan.upload,
            ...(options.project ? { projectAlias: options.project as string } : {}),
            ...(options.upload === true ? { enabled: true } : {}),
          }
        : options.upload === true || options.project
          ? {
              enabled: options.upload === true,
              ...(options.project ? { projectAlias: options.project as string } : {}),
            }
          : undefined;
      const printPlan: ResolvedRunPlan = {
        ...resolvedPlan,
        // Explicit target overrides the suite entirely — don't inherit
        // the original suite name or kinds (they'd misrepresent what
        // discovery actually scans). `kinds` is required by SuiteConfig,
        // so use [] to signal "no kind filter declared here".
        suites: explicitTargetGiven
          ? [{ name: "(override)", target: resolvedTarget, kinds: [] }]
          : resolvedPlan.suites,
        execution: { ...resolvedPlan.execution, failFast },
        reporters: {
          ...resolvedPlan.reporters,
          ...(printJunit ? { junit: printJunit } : {}),
          ...(printResultJson !== undefined ? { resultJson: printResultJson } : {}),
        },
        ...(overrideUpload ? { upload: overrideUpload } : {}),
      };
      console.log(formatResolvedPlan(printPlan));
      console.log("");
    }

    await runCommand(resolvedTarget, {
      filter: options.filter ?? resolvedPlan?.selection.filter,
      pick: options.pick ?? resolvedPlan?.selection.pick,
      tags: (cliTags && cliTags.length > 0) ? cliTags : resolvedPlan?.selection.tags,
      // tagMode: commander always supplies the default "or" so use cli-source
      // detection to know if user actually typed --tag-mode. Otherwise plan wins.
      tagMode: cliSrc("tagMode")
        ? (options.tagMode as "or" | "and")
        : (resolvedPlan?.selection.tagMode ?? (options.tagMode as "or" | "and")),
      excludeTags: (cliExcludeTags && cliExcludeTags.length > 0)
        ? cliExcludeTags
        : resolvedPlan?.selection.excludeTags,
      // envFile: only set when CLI explicitly or profile sets non-default
      // value. runCommand treats any envFile as user-specified and fails
      // hard if the file doesn't exist; falling back silently to ".env"
      // (the plan builtin default) would break projects without a .env.
      envFile: options.envFile ?? (resolvedPlan && resolvedPlan.envFile !== ".env"
        ? resolvedPlan.envFile
        : undefined),
      logFile: options.logFile,
      pretty: options.pretty,
      verbose: options.verbose,
      failFast,
      // failAfter: preserve `null` (= "no count limit") explicitly from
      // plan as a real null — mergeRunOptions distinguishes null
      // (override to "off") from undefined (no override, legacy config can
      // still set a limit). Coercing null→undefined would let legacy
      // package.json `glubean.run.failAfter` re-introduce a count limit.
      failAfter: options.failAfter
        ? parseInt(options.failAfter, 10)
        : resolvedPlan
          ? resolvedPlan.execution.failAfter // may be number, null, or 0 (already validated as >=1 or null)
          : undefined,
      timeoutMs: resolvedPlan?.execution.timeoutMs,
      concurrency: resolvedPlan?.execution.concurrency,
      resultJson,
      emitFullTrace: options.emitFullTrace ?? resolvedPlan?.reporters.emitFullTrace,
      inferSchema: options.inferSchema ?? resolvedPlan?.reporters.inferSchema,
      truncateArrays: options.truncateArrays ?? resolvedPlan?.reporters.truncateArrays,
      configFiles,
      inspectBrk: options.inspectBrk,
      reporter,
      reporterPath,
      traceLimit: options.traceLimit ? parseInt(options.traceLimit, 10) : undefined,
      includeBrowser: options.includeBrowser ?? resolvedPlan?.capabilities.browser,
      includeOutOfBand: options.includeOutOfBand ?? resolvedPlan?.capabilities.outOfBand,
      includeOptIn: options.includeOptIn ?? resolvedPlan?.capabilities.optIn,
      noSession: options.noSession ?? resolvedPlan?.execution.noSession,
      meta: options.meta?.length
        ? (options.meta as string[]).reduce((acc: Record<string, string>, item: string) => {
            const eq = item.indexOf("=");
            if (eq > 0) acc[item.slice(0, eq)] = item.slice(eq + 1);
            return acc;
          }, {})
        : undefined,
      upload: options.upload ?? resolvedPlan?.upload?.enabled,
      // When profile has upload.projectAlias and CLI didn't pass --project,
      // forward the alias as the project identifier so the upload preflight
      // doesn't exit with "no project ID found". `resolveProjectId` accepts
      // either a project ID or an alias.
      project: options.project ?? resolvedPlan?.upload?.projectAlias,
      token: options.token,
      apiUrl: options.apiUrl,
      inputJson: options.inputJson,
      bootstrapJson: options.bootstrapJson,
      forceStandalone: options.forceStandalone,
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
// contracts command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("contracts")
  .description("Project contract specs as human-readable or machine-readable output")
  .option("-d, --dir <path>", "Project directory", ".")
  .option(
    "-f, --format <format>",
    "Output format: md-outline | json | openapi | list-formats | <registered kind>",
    "md-outline",
  )
  .option("--title <title>", "API title (format=openapi only)")
  .action(async (options) => {
    const { contractsCommand } = await import("./commands/contracts.js");
    await contractsCommand({
      dir: options.dir,
      format: options.format,
      title: options.title,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// migrate command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("migrate")
  .description("Preview or apply v0.1.x -> v10 project migrations")
  .option("-d, --dir <path>", "Project directory", ".")
  .option("--apply", "Write changes instead of printing a dry-run diff")
  .action(async (options) => {
    await migrateCommand({
      dir: options.dir,
      apply: options.apply,
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
// upgrade command
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("upgrade")
  .description("Upgrade Glubean CLI to the latest version")
  .action(async () => {
    await upgradeCommand(CLI_VERSION);
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
