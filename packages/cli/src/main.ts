/**
 * Glubean CLI - Main entry point
 *
 * Uses Commander.js for structured command handling with automatic help
 * generation, argument validation, and shell completions.
 */

// Support running from outside workspace (e.g. shell alias with GLUBEAN_CWD)
const _cwd = process.env["GLUBEAN_CWD"];
if (_cwd) process.chdir(_cwd);

import { Command, Option } from "commander";
import { CLI_VERSION } from "./version.js";
import {
  loadProjectConfigV1,
  resolveRunPlan,
  GlubeanConfigError,
  type CliProfileOverrides,
  type ResolvedRunPlan,
} from "./lib/config.js";
import { formatResolvedPlan } from "./lib/print-plan.js";
import { initCommand } from "./commands/init.js";
import { runCommand, resolveTestFilesForSuite } from "./commands/run.js";
import { scanCommand } from "./commands/scan.js";
import { dryRunCommand } from "./commands/dry-run.js";
import { syncCommand } from "./commands/sync.js";
import { loadCommand } from "./commands/load.js";
import { validateMetadataCommand } from "./commands/validate_metadata.js";
import { loginCommand } from "./commands/login.js";
import { patchCommand } from "./commands/patch.js";
import { specSplitCommand } from "./commands/spec_split.js";
import { redactCommand } from "./commands/redact.js";
import { configMcpCommand } from "./commands/config_mcp.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { migrateCommand } from "./commands/migrate.js";

import { envShowCommand, envUseCommand, envResetCommand, envListCommand } from "./commands/env.js";
import { qaOpenCommand, qaAttachCommand, qaStopCommand } from "./commands/qa.js";
import { abortUpdateCheck, checkForUpdates } from "./update_check.js";

const program = new Command();

/**
 * The `--api-url` flag: an INTERNAL escape hatch to override the Platform API
 * URL for a single command. Hidden from `--help` (via `.hideHelp()`) because
 * the user-facing path is the GLUBEAN_API_URL env var (auto-derived to the
 * Platform host — see resolveApiUrl in ./lib/auth.ts); `--api-url` /
 * GLUBEAN_PLATFORM_API_URL are for non-standard/self-hosted setups only. Still
 * fully parsed — `options.apiUrl` is populated and threads into resolveApiUrl.
 * Shared factory so all five commands (run / ci run / load / sync / login)
 * stay identical (a fresh Option per call — Options are stateful, not reusable).
 */
const hiddenApiUrlOption = (): Option =>
  new Option(
    "--api-url <url>",
    "internal: override the Platform API URL (prefer GLUBEAN_PLATFORM_API_URL / GLUBEAN_API_URL env vars)",
  ).hideHelp();

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
  .option("--template <name>", "Scaffold a named template (currently: demo — the public demo project)")
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
      template: options.template,
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
    "Run only the named suite from the profile. The name must already appear in `profile.suites`. (Single value — narrows a multi-suite profile to one suite.)",
  )
  .option("-t, --tag <tag>", "Run only tests with matching tag (comma-separated or repeatable)", collect, [])
  .option("--tag-mode <mode>", 'Tag match logic: "or" (any tag) or "and" (all tags)', "or")
  .option("--exclude-tag <tag>", "Exclude tests with matching tag (comma-separated or repeatable; always OR-mode — any match drops the test)", collect, [])
  .option("--env-file <path>", "Path to .env file (default: active env set via 'glubean env use', else .env; prod-like active envs are refused implicitly — pass this flag explicitly)")
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
  .option("--include-browser", "Include cases that require a browser (e.g., OAuth login)")
  .option("--include-out-of-band", "Include cases that require out-of-band channels (email, SMS)")
  .option("--include-opt-in", "Include opt-in cases (expensive, slow, or side-effect-producing)")
  .option("--no-session", "Skip session setup/teardown")
  .option("-M, --meta <key=value>", "Custom run metadata (repeatable)", collect, [])
  .option("--upload", "Upload run results and artifacts to Glubean Cloud")
  .option("--upload-receipt-json <path>", "Write Cloud upload receipt JSON after --upload")
  .option("--keep-local", "Keep local screenshot files after --upload (skip post-upload cleanup)")
  .option("--project <id>", "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)")
  .option("--upload-target <id>", "Cloud target id runs upload to (or GLUBEAN_TARGET_ID; else project default)")
  .option("--token <token>", "Auth token for cloud upload (or GLUBEAN_TOKEN env)")
  .addOption(hiddenApiUrlOption())
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
  .option(
    "--only-id <id>",
    "Run only the test(s) with matching id (repeatable). For `.each` rows pass the concrete expanded id.",
    collect,
    [],
  )
  .option(
    "--row <n>",
    "With a single --only-id, isolate the 0-based `.each` row index.",
  )
  .option(
    "--rerun-failed",
    "Re-run only the tests that failed in the last `glubean run` (reads .glubean/last-run.result.json).",
  )
  .action(async (target, options, cmd) => {
    await executeRun(target, options, cmd);
  });

// Extracted run handler so both `glubean run` and `glubean ci run` can
// share it. The CI subcommand is just `run` with `--profile ci` baked
// in as the default.
async function executeRun(
  target: string | undefined,
  options: Record<string, unknown> & Record<string, any>,
  cmd: Command,
): Promise<void> {
    // Flatten --config values
    const configFiles = options.config && options.config.length > 0
      ? (options.config as string[]).flatMap((v: string) =>
        v.split(",").map((s: string) => s.trim()).filter(Boolean)
      )
      : undefined;

    // Config consolidation (docs/06 P2): a bare `glubean run` (no target, no
    // profile) defaults to the `local` profile — there's no global
    // testDir/exploreDir config outside glubean.yaml anymore. The deprecated
    // `--explore` flag maps to the `explore` profile. This MUST run before
    // the --suite guard below so `glubean run --suite X` (no target) narrows
    // the defaulted local profile instead of erroring "requires --profile".
    if (options.explore) {
      console.warn(
        `\x1b[33m--explore is deprecated; use \`glubean run --profile explore\` ` +
          `(define an \`explore\` profile in glubean.yaml).\x1b[0m`,
      );
    }
    if (!target && !options.profile) {
      options.profile = options.explore ? "explore" : "local";
    }

    // --suite is a profile-mode-only override. Reject it without --profile
    // so the user sees the broader-than-expected run before it starts,
    // instead of silently ignoring the flag. (No-target runs already have a
    // profile from the defaulting above, so this only fires for ad-hoc
    // `glubean run <target> --suite X` with no profile.)
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
    // Multi-suite profiles are fully supported: every declared suite is
    // expanded into a concatenated file list with a per-file kind
    // allow-list, in suite declaration order (see the resolvedTarget block
    // below). runCommand accepts `string | string[]` and runs them in a
    // single pass with unified reporter output.
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
        // --suite is a single-value narrowing override: it restricts the
        // resolved profile to one of its already-declared suites. To run
        // several suites, declare them in the profile — multi-suite
        // expansion is handled by the resolvedTarget block below.
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
        if (resolvedPlan.suites.length === 0) {
          console.error(
            `\x1b[31mProfile "${resolvedPlan.profile}" has an empty \`suites\` ` +
              `list. Add at least one suite name in glubean.yaml ` +
              `(e.g. \`profiles.${resolvedPlan.profile}.suites: [tests]\`).\x1b[0m`,
          );
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

    // Resolve target from config when not explicitly provided. In profile
    // mode this iterates each suite, applies its `kinds` filter at the
    // file level, and passes the concatenated file list as the target.
    // runCommand accepts `string | string[]` so a multi-suite profile
    // discovers + runs all suites in a single pass with unified reporter
    // output. (Phase 4 multi-suite execution + the resolved suite.kinds
    // filter that was the documented E1 gap from Phase 1 sub-task E1.)
    let resolvedTarget: string | string[] | undefined = target;
    // Per-file allow-list of runnable kinds for the multi-suite path.
    // Built alongside `resolvedTarget` so runCommand can drop runnables
    // whose kind isn't in any contributing suite's declared kinds —
    // protects mixed-export files (e.g. `.contract.ts` with an inline
    // `contract.flow(...)`).
    let allowedKindsPerFile:
      | Map<string, Set<"test" | "contract" | "flow">>
      | undefined;
    if (!resolvedTarget) {
      if (resolvedPlan && resolvedPlan.suites.length > 0) {
        // Preserve profile.suites declaration order — it controls
        // file:start ordering downstream, which interacts with
        // failFast / failAfter (early failures in earlier suites
        // short-circuit later suites). Dedupe while preserving order
        // when the same path appears across suites.
        const seen = new Set<string>();
        const allFiles: string[] = [];
        allowedKindsPerFile = new Map();
        for (const suite of resolvedPlan.suites) {
          const suiteFiles = await resolveTestFilesForSuite(
            suite.target,
            suite.kinds,
          );
          // A declared suite that resolves to zero files is almost always a
          // typo (wrong dir, wrong kinds filter). Fail loudly per-suite so
          // CI surfaces the misconfiguration instead of silently dropping
          // it into the aggregate.
          if (suiteFiles.length === 0) {
            console.error(
              `\x1b[31mSuite "${suite.name}" (target: ${suite.target}, ` +
                `kinds: ${suite.kinds.join(", ") || "any"}) resolved to ` +
                `zero test files. Check the directory exists and contains ` +
                `*.${suite.kinds.join(".ts / *.")}.ts files matching the ` +
                `declared kinds.\x1b[0m`,
            );
            process.exit(1);
          }
          // When a suite has no declared kinds, allow all three. Otherwise
          // union the declared kinds into the per-file allow-list (a file
          // shared between suites with different kinds runs the union).
          const suiteKindSet: Set<"test" | "contract" | "flow"> =
            suite.kinds.length === 0
              ? new Set(["test", "contract", "flow"])
              : new Set(
                  suite.kinds.filter(
                    (k): k is "test" | "contract" | "flow" =>
                      k === "test" || k === "contract" || k === "flow",
                  ),
                );
          for (const f of suiteFiles) {
            const existing = allowedKindsPerFile.get(f);
            if (existing) {
              for (const k of suiteKindSet) existing.add(k);
            } else {
              allowedKindsPerFile.set(f, new Set(suiteKindSet));
            }
            if (seen.has(f)) continue;
            seen.add(f);
            allFiles.push(f);
          }
        }
        resolvedTarget = allFiles;
      } else {
        // Unreachable: a missing target with no profile is normalized to the
        // `local`/`explore` profile above, so resolvedPlan (with ≥1 suite) is
        // always present on this branch. Guard the type + invariant.
        console.error(
          `\x1b[31mNo run target resolved. Pass a path, or define a ` +
            `\`local\` profile in glubean.yaml.\x1b[0m`,
        );
        process.exit(1);
      }
    }

    const failFast = resolvedPlan?.execution.failFast ?? options.failFast;
    let reporter = options.reporter;
    let reporterPath: string | undefined;
    // Profile's `reporters.junit` implies `--reporter junit` (with the
    // profile-supplied path) when the user didn't pass --reporter on the CLI.
    if (!reporter && resolvedPlan?.reporters.junit) {
      reporter = "junit";
    }
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
      // Any user-supplied positional target overrides suite expansion —
      // resolvedTarget becomes that single string instead of the file
      // array built from per-suite resolution. Comparing to a specific
      // suite's target as a "did they really override?" heuristic would
      // misreport the plan when the user passes the same path string
      // that happens to match the first suite's target.
      const explicitTargetGiven = !!target;
      // junit reporter active iff `reporter === "junit"` after the
      // resolution above (from CLI or profile).
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
      // Upload destination: when `--project <id>` is passed, the upload routes
      // to that project id, overriding the profile's `projectId`. Reflect that
      // (+ the enable bit and the effective TARGET) so the printed plan matches
      // the actual destination. The target mirrors the executeRun resolution
      // below: --upload-target wins, else the profile target UNLESS --project
      // overrode the project (a profile target belongs to its own project), else
      // the project's default target (resolved at run → shown as "(default)").
      const effectiveUploadTarget =
        (options.uploadTarget as string | undefined) ??
        (options.project ? undefined : resolvedPlan.upload?.targetId) ??
        process.env.GLUBEAN_TARGET_ID;
      const overrideUpload = resolvedPlan.upload
        ? {
            ...resolvedPlan.upload,
            ...(options.project ? { projectId: options.project as string } : {}),
            targetId: effectiveUploadTarget,
            ...(options.upload === true ? { enabled: true } : {}),
          }
        : options.upload === true || options.project
          ? {
              enabled: options.upload === true,
              ...(options.project ? { projectId: options.project as string } : {}),
              ...(effectiveUploadTarget ? { targetId: effectiveUploadTarget } : {}),
            }
          : undefined;
      const printPlan: ResolvedRunPlan = {
        ...resolvedPlan,
        // Explicit target overrides the suite entirely — don't inherit
        // the original suite name or kinds (they'd misrepresent what
        // discovery actually scans). `kinds` is required by SuiteConfig,
        // so use [] to signal "no kind filter declared here". The
        // explicit `target` is the user-supplied positional arg (always
        // a single string) — distinct from `resolvedTarget` which may be
        // the file array built from per-suite resolution below.
        suites: explicitTargetGiven
          ? [{ name: "(override)", target: target as string, kinds: [] }]
          : resolvedPlan.suites,
        execution: {
          ...resolvedPlan.execution,
          failFast,
          // Reflect --no-session in the printed plan so the visible
          // record matches the actual run.
          ...(options.session === false ? { noSession: true } : {}),
        },
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

    // B2 M3 — parse + validate --row (a 0-based `.each` row index). Commander
    // hands it through as a raw string; reject anything that isn't a
    // non-negative integer before runCommand builds selectors.
    let parsedRow: number | undefined;
    if (options.row !== undefined) {
      const raw = String(options.row).trim();
      if (!/^\d+$/.test(raw)) {
        console.error(
          `\x1b[31m--row must be a non-negative integer (got "${options.row}").\x1b[0m`,
        );
        process.exit(1);
      }
      parsedRow = parseInt(raw, 10);
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
      // Commander stores `--no-session` as `options.session === false`
      // (NOT `options.noSession`). Treat either form as the negation
      // signal so the long-standing CLI bug doesn't bite ci run users.
      noSession:
        options.noSession === true || options.session === false
          ? true
          : resolvedPlan?.execution.noSession,
      meta: options.meta?.length
        ? (options.meta as string[]).reduce((acc: Record<string, string>, item: string) => {
            const eq = item.indexOf("=");
            if (eq > 0) acc[item.slice(0, eq)] = item.slice(eq + 1);
            return acc;
          }, {})
        : undefined,
      upload: options.upload ?? resolvedPlan?.upload?.enabled,
      uploadReceiptJson: options.uploadReceiptJson,
      // ART1-B escape hatch: keep local screenshots after a successful upload.
      keepLocal: options.keepLocal,
      // When the profile declares upload.projectId and CLI didn't pass
      // --project, forward it as the project identifier so the upload
      // preflight doesn't exit with "no project ID found". The value may be
      // a project id or a cloud alias (resolved server-side).
      project: options.project ?? resolvedPlan?.upload?.projectId,
      // Upload TARGET (runs live under a target — ADR 0007). CLI --upload-target
      // wins. Otherwise inherit the profile's upload.targetId ONLY when --project
      // didn't override the destination project — a profile target belongs to the
      // profile's project, so pairing it with an overridden project would post to
      // /projects/<override>/targets/<profile-target> and 404. With an override
      // and no --upload-target, fall through to the override project's default
      // target (resolved server-side). Env GLUBEAN_TARGET_ID still applies via
      // resolveTargetId when nothing is passed here.
      target:
        (options.uploadTarget as string | undefined) ??
        (options.project ? undefined : resolvedPlan?.upload?.targetId),
      // Per-profile token reference: which env var holds THIS profile's
      // upload token. resolveToken reads it exclusively (no GLUBEAN_TOKEN
      // fallback) so profiles can target different projects safely.
      tokenEnv: resolvedPlan?.upload?.tokenEnv,
      token: options.token,
      apiUrl: options.apiUrl,
      inputJson: options.inputJson,
      bootstrapJson: options.bootstrapJson,
      forceStandalone: options.forceStandalone,
      // B2 M3 — `{id, rowIndex}` selectors. onlyId is a collected array (may be
      // empty); row is the validated integer; rerunFailed is a boolean flag.
      onlyId: options.onlyId as string[] | undefined,
      row: parsedRow,
      rerunFailed: !!options.rerunFailed,
      allowedKindsPerFile,
      // Phase 4: thread the v1 plan's full redaction config (replacement
      // format + globalRules + custom patterns) into runCommand so newly
      // init'd projects (which scaffold `defaults.redaction` in
      // glubean.yaml) keep their declared security posture for upload
      // events. The legacy loadConfig path doesn't read glubean.yaml, so
      // without this the upload would use the legacy defaults regardless
      // of what the project declared.
      redactionConfig: resolvedPlan?.redaction,
      // Plan 06 P1 — v1 profile thresholds (defaults.thresholds ∪
      // profile.thresholds). runCommand prefers these over legacy
      // package.json thresholds when non-empty.
      thresholds: resolvedPlan?.thresholds,
      // Phase 5 5a — pass profile name + suite names so runCommand can
      // emit `metadata.runPlan` on upload. Cloud server projects these
      // to top-level RunEntity fields for query indexing.
      // When the user supplied an explicit positional target, suites
      // from the profile didn't drive expansion (resolvedTarget is the
      // raw target string, not the per-suite file list) — omit suites
      // so `?suite=Y` queries don't incorrectly match runs that didn't
      // actually execute suite Y. Profile name stays meaningful (its
      // selection/execution/reporters still applied).
      profile: resolvedPlan?.profile,
      suites: target ? undefined : resolvedPlan?.suites.map((s) => s.name),
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// ci subcommand — Phase 3 tasks 3+4
//
// `glubean ci run` is the explicit CI entry point. It's equivalent to
// `glubean run --profile ci`, but it makes the CI dependency on
// `profiles.ci` visible at the command surface (instead of via a hidden
// flag). When the project has no `profiles.ci`, the underlying profile
// resolution fails closed with a list of available profiles — no silent
// fallback.
// ─────────────────────────────────────────────────────────────────────────────
const ciCmd = program
  .command("ci")
  .description("CI-mode subcommands (entry point: `glubean ci run`).");

ciCmd
  .command("run [target]")
  .description(
    "Run tests with the `ci` profile from glubean.yaml. Equivalent to " +
      "`glubean run --profile ci`. A multi-suite `profiles.ci` runs all " +
      "its declared suites; use `--suite <name>` to narrow to one.",
  )
  // `--explore` deliberately omitted on ci run: in the v1 config model the
  // explore-vs-test distinction is a dedicated profile (e.g.
  // `glubean run --profile explore`), not a flag on the CI entry point.
  .option("-f, --filter <pattern>", "Run only tests matching pattern (name or id substring)")
  .option(
    "--suite <name>",
    "Run only the named suite from the `ci` profile. The name must already appear in `profile.suites`. (Single value — narrows a multi-suite profile to one suite.)",
  )
  .option("-t, --tag <tag>", "Run only tests with matching tag (comma-separated or repeatable)", collect, [])
  .option("--tag-mode <mode>", 'Tag match logic: "or" (any tag) or "and" (all tags)', "or")
  .option("--exclude-tag <tag>", "Exclude tests with matching tag (comma-separated or repeatable; always OR-mode — any match drops the test)", collect, [])
  .option("--env-file <path>", "Path to .env file (default: active env set via 'glubean env use', else .env; prod-like active envs are refused implicitly — pass this flag explicitly)")
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
  .option("--include-browser", "Include cases that require a browser (e.g., OAuth login)")
  .option("--include-out-of-band", "Include cases that require out-of-band channels (email, SMS)")
  .option("--include-opt-in", "Include opt-in cases (expensive, slow, or side-effect-producing)")
  .option("--no-session", "Skip session setup/teardown")
  .option("-M, --meta <key=value>", "Custom run metadata (repeatable)", collect, [])
  .option("--upload", "Upload run results and artifacts to Glubean Cloud")
  .option("--upload-receipt-json <path>", "Write Cloud upload receipt JSON after --upload")
  .option("--keep-local", "Keep local screenshot files after --upload (skip post-upload cleanup)")
  .option("--project <id>", "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)")
  .option("--upload-target <id>", "Cloud target id runs upload to (or GLUBEAN_TARGET_ID; else project default)")
  .option("--token <token>", "Auth token for cloud upload (or GLUBEAN_TOKEN env)")
  .addOption(hiddenApiUrlOption())
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
  .option(
    "--only-id <id>",
    "Run only the test(s) with matching id (repeatable). For `.each` rows pass the concrete expanded id.",
    collect,
    [],
  )
  .option(
    "--row <n>",
    "With a single --only-id, isolate the 0-based `.each` row index.",
  )
  .option(
    "--rerun-failed",
    "Re-run only the tests that failed in the last `glubean run` (reads .glubean/last-run.result.json).",
  )
  .action(async (target, options, cmd) => {
    // Bake in the `ci` profile so executeRun's profile-mode branch fires.
    // The user can't override this — that would defeat the point of the
    // subcommand. To run a different profile they'd use `glubean run --profile <X>`.
    (options as Record<string, unknown>).profile = "ci";
    await executeRun(target, options as Record<string, unknown> & Record<string, any>, cmd);
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
// dry-run command — project test SHAPE (assertions/endpoints) without running
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("dry-run")
  .description("Project each simple test's shape (assertions, endpoints) without running it")
  .option("-d, --dir <path>", "Directory to scan", ".")
  .option("--json", "Output as JSON")
  .option("--out <path>", "Write the projection JSON to a file")
  .action(async (options) => {
    await dryRunCommand({
      dir: options.dir,
      json: options.json,
      out: options.out,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// sync command — sync test-definition projections (specs) to Glubean Cloud
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Sync the repo's test-definition projections (metadata + dry-run shape) to Glubean Cloud for team review")
  .option("-d, --dir <path>", "Locate the project from this directory (the WHOLE project is always synced)", ".")
  .option("--project <id>", "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)")
  .option("--token <token>", "Auth token (or GLUBEAN_TOKEN env)")
  .option("--token-env <name>", "Read the token from this env var instead of GLUBEAN_TOKEN")
  .addOption(hiddenApiUrlOption())
  .option("--env-file <name>", "Env file basename to load (default: active env, else .env; prod-like active envs are refused implicitly)")
  .option("--allow-empty", "Allow clearing the project's projections when no tests are found")
  .action(async (options) => {
    await syncCommand({
      dir: options.dir,
      project: options.project,
      token: options.token,
      tokenEnv: options.tokenEnv,
      apiUrl: options.apiUrl,
      envFile: options.envFile,
      allowEmpty: options.allowEmpty,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// load command — run performance plans (.load.ts)
// ─────────────────────────────────────────────────────────────────────────────
program
  .command("load [target]")
  .description("Run loadRunner() performance plans (.load.ts) and write LoadArtifacts")
  .option("--env-file <name>", "Env file basename (default: active env, else .env; prod-like active envs are refused implicitly)")
  .option("--upload", "Upload each plan's LoadArtifact to Glubean Cloud")
  .option("--upload-receipt-json <path>", "Write Cloud upload receipt(s) JSON after --upload")
  .option("--project <id>", "Glubean Cloud project ID (or GLUBEAN_PROJECT_ID env)")
  .option("--upload-target <id>", "Cloud target id runs upload to (or GLUBEAN_TARGET_ID; else project default)")
  .option("--token <token>", "Auth token for cloud upload (or GLUBEAN_TOKEN env)")
  .addOption(hiddenApiUrlOption())
  .action(async (target, options) => {
    await loadCommand(target, {
      envFile: options.envFile,
      upload: options.upload,
      uploadReceiptJson: options.uploadReceiptJson,
      project: options.project,
      target: options.uploadTarget,
      token: options.token,
      apiUrl: options.apiUrl,
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
  .option(
    "--projection <name>",
    "Generate a named contract projection declared in glubean.yaml's " +
      "`projections.contracts` (or \"all\" for every declared entry), " +
      "writing each to its configured `output` path. Ignores --dir/--format/--title.",
  )
  .option(
    "--config <path>",
    "Path to glubean.yaml (default: ./glubean.yaml). Used with --projection.",
  )
  .action(async (options) => {
    const { contractsCommand } = await import("./commands/contracts.js");
    await contractsCommand({
      dir: options.dir,
      format: options.format,
      title: options.title,
      projection: options.projection,
      config: options.config,
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
  .description("Authenticate with Glubean Cloud (device authorization in your browser)")
  .option("--token <token>", "Save a project token directly (skip the browser device flow)")
  .option("--project <id>", "Default project ID")
  .addOption(hiddenApiUrlOption())
  .option("--auth-url <url>", "Auth server URL for login (or GLUBEAN_AUTH_URL)")
  .option("--no-browser", "Don't auto-open the browser; print the URL to open manually")
  .action(async (options) => {
    await loginCommand({
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
      authUrl: options.authUrl,
      // commander stores --no-browser as options.browser === false
      noBrowser: options.browser === false,
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
// qa — Mode B QA recorder (GLU-234/235 · P1-4/P1-5): passively record the agent's
// browser and seal an agent-qa-report/v1.
// ─────────────────────────────────────────────────────────────────────────────
const qaCmd = program.command("qa").description("Mode B QA recorder (passive record + seal an agent-qa-report/v1)");

qaCmd
  .command("open")
  .description("Launch an instrumented browser, print its CDP endpoint, and record until `qa stop`")
  .requiredOption("--file <path>", "path to the .browser.ts contract")
  .requiredOption("--case <key>", "case key to record")
  .option("--report <path>", "where to write the sealed report")
  .option("--model <id>", "recording agent model id for the report (or set GLUBEAN_QA_MODEL)")
  .option("--contract <id>", "disambiguate when several contracts in the file share the case key")
  .action(async (opts) => {
    await qaOpenCommand({ file: opts.file, case: opts.case, report: opts.report, model: opts.model, contract: opts.contract });
  });

qaCmd
  .command("attach")
  .description("Attach to the agent's already-running browser (CDP endpoint) and record")
  .requiredOption("--endpoint <ws>", "CDP endpoint (ws:// or http:// discovery URL) of the agent's browser")
  .requiredOption("--file <path>", "path to the .browser.ts contract")
  .requiredOption("--case <key>", "case key to record")
  .option("--report <path>", "where to write the sealed report")
  .option("--model <id>", "recording agent model id for the report (or set GLUBEAN_QA_MODEL)")
  .option("--contract <id>", "disambiguate when several contracts in the file share the case key")
  .action(async (opts) => {
    await qaAttachCommand({ endpoint: opts.endpoint, file: opts.file, case: opts.case, report: opts.report, model: opts.model, contract: opts.contract });
  });

qaCmd
  .command("stop")
  .description("Seal the current recording session into an agent-qa-report/v1")
  .action(() => {
    qaStopCommand();
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
