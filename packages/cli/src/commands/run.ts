import {
  evaluateThresholds,
  type ExecutionEvent,
  MetricCollector,
  ProjectRunner,
  buildRunContext,
} from "@glubean/runner";
import type { ProjectRunnerTest } from "@glubean/runner";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { stat, readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { loadConfig, mergeRunOptions, toSharedRunConfig } from "../lib/config.js";
import { loadProjectEnv } from "@glubean/runner";
import { resolveEnvFileName } from "../lib/active_env.js";
import { shouldSkipTest, type CapabilityProfile } from "../lib/skip.js";
import { CLI_VERSION } from "../version.js";
import type { UploadResultPayload } from "../lib/upload.js";
import { extractContractCases, extractFromSource } from "@glubean/scanner/static";
import { extractContractFromFile } from "@glubean/scanner";

// ANSI color codes for pretty output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const CLOUD_MEMORY_LIMITS = {
  free: 300,
  pro: 700,
};

const MEMORY_WARNING_THRESHOLD_MB = CLOUD_MEMORY_LIMITS.free * 0.67;

interface RunOptions {
  filter?: string;
  pick?: string;
  tags?: string[];
  tagMode?: "or" | "and";
  envFile?: string;
  logFile?: boolean;
  pretty?: boolean;
  verbose?: boolean;
  failFast?: boolean;
  failAfter?: number;
  resultJson?: boolean | string;
  emitFullTrace?: boolean;
  inferSchema?: boolean;
  truncateArrays?: boolean;
  configFiles?: string[];
  inspectBrk?: number | boolean;
  reporter?: string;
  reporterPath?: string;
  traceLimit?: number;
  /** Include cases with requires: "browser" */
  includeBrowser?: boolean;
  /** Include cases with requires: "out-of-band" */
  includeOutOfBand?: boolean;
  /** Include cases with defaultRun: "opt-in" (headless but expensive/slow) */
  includeOptIn?: boolean;
  upload?: boolean;
  project?: string;
  token?: string;
  apiUrl?: string;
  noSession?: boolean;
  meta?: Record<string, string>;
}

// =============================================================================
// Capability profile — determines which cases can run
// (shouldSkipTest + CapabilityProfile imported from ../lib/skip.js)
// =============================================================================

interface CollectedTestRun {
  testId: string;
  testName: string;
  tags?: string[];
  filePath: string;
  events: ExecutionEvent[];
  success: boolean;
  durationMs: number;
  groupId?: string;
}

interface RunSummaryStats {
  httpRequestTotal: number;
  httpErrorTotal: number;
  assertionTotal: number;
  assertionFailed: number;
  warningTotal: number;
  warningTriggered: number;
  stepTotal: number;
  stepPassed: number;
  stepFailed: number;
}

interface LogEntry {
  timestamp: string;
  testId: string;
  testName: string;
  type: "log" | "trace" | "assertion" | "metric" | "error" | "result" | "action" | "event";
  message: string;
  data?: unknown;
}

async function findProjectConfig(
  startDir: string,
): Promise<{ rootDir: string; configPath?: string }> {
  let dir = startDir;
  while (dir !== "/") {
    try {
      const pkgJson = resolve(dir, "package.json");
      await stat(pkgJson);
      // Check if this is a glubean project (has @glubean/sdk dependency)
      // If not, keep walking up — this avoids latching onto unrelated parent projects
      const content = JSON.parse(await readFile(pkgJson, "utf-8"));
      const deps = { ...content.dependencies, ...content.devDependencies };
      if ("@glubean/sdk" in deps || content.glubean) {
        return { rootDir: dir, configPath: pkgJson };
      }
    } catch {
      // parse error or stat error — skip
    }
    dir = resolve(dir, "..");
  }
  // No glubean project found — use the starting directory (scratch mode)
  return { rootDir: startDir };
}

const DEFAULT_SKIP_DIRS = ["node_modules", ".git", "dist", "build"];
const DEFAULT_EXTENSIONS = ["ts"];

function isGlob(target: string): boolean {
  return /[*?{[]/.test(target);
}

const TEST_FILE_SUFFIXES = [".test.ts", ".contract.ts", ".flow.ts"];

function isGlubeanTestFile(name: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function walkTestFiles(dir: string, result: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_SKIP_DIRS.includes(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isFile() && isGlubeanTestFile(entry.name)) {
      result.push(full);
    } else if (entry.isDirectory()) {
      await walkTestFiles(full, result);
    }
  }
}

async function resolveTestFiles(target: string): Promise<string[]> {
  const abs = resolve(target);

  try {
    const s = await stat(abs);
    if (s.isFile()) return [abs];

    if (s.isDirectory()) {
      const files: string[] = [];
      await walkTestFiles(abs, files);
      files.sort();
      return files;
    }
  } catch {
    // stat failed — might be a glob pattern
  }

  if (isGlob(target)) {
    const files: string[] = [];
    for await (const entry of glob(target, { cwd: process.cwd() })) {
      const full = resolve(process.cwd(), entry);
      if (isGlubeanTestFile(full)) {
        const s = await stat(full).catch(() => null);
        if (s?.isFile()) files.push(full);
      }
    }
    files.sort();
    return files;
  }

  return [abs];
}

interface DiscoveredTestMeta {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  timeout?: number;
  skip?: boolean;
  only?: boolean;
  groupId?: string;
  parallel?: boolean;
  requires?: string;
  defaultRun?: string;
  deferred?: string;
  deprecated?: string;
}

interface DiscoveredTest {
  exportName: string;
  meta: DiscoveredTestMeta;
}

export async function discoverTests(filePath: string): Promise<DiscoveredTest[]> {
  const content = await readFile(filePath, "utf-8");

  if (filePath.includes(".contract.") || filePath.includes(".flow.")) {
    // Runtime extraction via shared function (supports .with() syntax).
    // Returns BOTH contracts and flows; v0.2+ flow files often export only
    // flows, so we must emit one DiscoveredTest per flow in addition to
    // per contract case.
    const result = await extractContractFromFile(filePath);

    const results: DiscoveredTest[] = [];

    for (const ec of result.contracts) {
      for (const c of ec.cases) {
        results.push({
          exportName: ec.exportName,
          meta: {
            id: `${ec.id}.${c.key}`,
            description: c.description,
            requires: c.requires,
            defaultRun: c.defaultRun,
            deferred: c.deferredReason,
            deprecated: c.deprecatedReason,
          },
        });
      }
    }

    // Each flow has a single orchestrator Test (setup → steps → teardown).
    // Discover it as one runnable entry with the flow id.
    if (result.flows) {
      for (const flow of result.flows) {
        results.push({
          exportName: flow.exportName,
          meta: {
            id: flow.id,
            description: flow.description,
            // Flow-level meta.skip was propagated to TestMeta.deferred
            // by the flow builder (contract-core.ts), surfaced via the
            // extracted projection's description where applicable.
          },
        });
      }
    }

    if (results.length > 0) return results;

    // Runtime failed — fall back to static regex (old syntax, contracts only)
    if (result.errors.length > 0) {
      const contracts = extractContractCases(content);
      if (contracts.length > 0) {
        for (const c of contracts) {
          for (const caseItem of c.cases) {
            results.push({
              exportName: c.exportName,
              meta: {
                id: `${c.contractId}.${caseItem.key}`,
                description: caseItem.description,
                requires: caseItem.requires,
                defaultRun: caseItem.defaultRun,
                deferred: caseItem.deferred,
              },
            });
          }
        }
        return results;
      }

      // Both runtime and static failed — surface the import error
      for (const err of result.errors) {
        console.error(`\x1b[31m✗ Contract import failed: ${err.file}\x1b[0m`);
        console.error(`\x1b[2m  ${err.error}\x1b[0m`);
      }
    }

    return [];
  }

  const metas = extractFromSource(content);
  return metas.map((m: any) => ({
    exportName: m.exportName,
    meta: {
      id: m.id,
      name: m.name,
      tags: m.tags,
      timeout: m.timeout,
      skip: m.skip,
      only: m.only,
      groupId: m.groupId,
      parallel: m.parallel,
    },
  }));
}

function matchesFilter(testItem: DiscoveredTest, filter: string): boolean {
  const lowerFilter = filter.toLowerCase();
  if (testItem.meta.id.toLowerCase().includes(lowerFilter)) return true;
  if (testItem.meta.name?.toLowerCase().includes(lowerFilter)) return true;
  return false;
}

function matchesTags(
  testItem: DiscoveredTest,
  tags: string[],
  mode: "or" | "and" = "or",
): boolean {
  if (!testItem.meta.tags?.length) return false;
  const lowerTestTags = testItem.meta.tags.map((t) => t.toLowerCase());
  const match = (t: string) => lowerTestTags.includes(t.toLowerCase());
  return mode === "and" ? tags.every(match) : tags.some(match);
}

function getLogFilePath(testFilePath: string): string {
  const lastDot = testFilePath.lastIndexOf(".");
  if (lastDot === -1) return testFilePath + ".log";
  return testFilePath.slice(0, lastDot) + ".log";
}

interface FileTest {
  filePath: string;
  exportName: string;
  test: DiscoveredTest;
}

function resolveOutputPath(userPath: string, cwd: string): string {
  if (isAbsolute(userPath)) {
    return resolve(userPath);
  }
  const resolved = resolve(cwd, userPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(
      `Output path "${userPath}" escapes the project directory. ` +
        `Use an absolute path to write outside the project.`,
    );
  }
  return resolved;
}

async function writeEmptyResult(target: string, runAt: string): Promise<void> {
  const payload = {
    target,
    files: [],
    runAt,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, stats: {} },
    tests: [],
  };
  try {
    const glubeanDir = resolve(process.cwd(), ".glubean");
    await mkdir(glubeanDir, { recursive: true });
    await writeFile(
      resolve(glubeanDir, "last-run.result.json"),
      JSON.stringify(payload, null, 2),
      "utf-8",
    );
  } catch {
    // Non-critical
  }
}

export async function runCommand(
  target: string,
  options: RunOptions = {},
): Promise<void> {
  const logEntries: LogEntry[] = [];
  const runStartDate = new Date();
  const runStartTime = runStartDate.toISOString();
  const runStartLocal = localTimeString(runStartDate);

  // ── Capability profile ──────────────────────────────────────────────────
  const isCiEnv = process.env.CI === "true" || process.env.GLUBEAN_CI === "true";

  // Hard fail: --include-browser/--include-out-of-band in CI
  if (isCiEnv && (options.includeBrowser || options.includeOutOfBand)) {
    console.error(
      `\n${colors.red}Error: --include-browser and --include-out-of-band cannot run in CI environments.${colors.reset}`,
    );
    console.error(
      `${colors.dim}CI has no browser or out-of-band channels. Remove these flags from your CI config.${colors.reset}\n`,
    );
    process.exit(1);
  }

  const capabilityProfile: CapabilityProfile = {
    browser: !!options.includeBrowser && !isCiEnv,
    outOfBand: !!options.includeOutOfBand && !isCiEnv,
    optIn: !!options.includeOptIn,
  };

  const interactive = capabilityProfile.browser;

  const traceCollector: Array<{
    testId: string;
    protocol?: string;
    target?: string;
    method?: string;
    url?: string;
    status: number | string;
  }> = [];

  console.log(
    `\n${colors.bold}${colors.blue}🧪 Glubean Test Runner${colors.reset}\n`,
  );

  const testFiles = await resolveTestFiles(target);
  const isMultiFile = testFiles.length > 1;

  if (testFiles.length === 0) {
    console.error(
      `\n${colors.red}❌ No test files found for target: ${target}${colors.reset}`,
    );
    console.error(
      `${colors.dim}Glubean looks for files matching *.test.ts, *.contract.ts, or *.flow.ts in the target directory.${colors.reset}`,
    );
    console.error(
      `${colors.dim}Run "glubean run tests/" or "glubean run path/to/file.test.ts".${colors.reset}\n`,
    );
    await writeEmptyResult(target, runStartLocal);
    process.exit(1);
  }

  if (isMultiFile) {
    console.log(`${colors.dim}Target: ${resolve(target)}${colors.reset}`);
    console.log(
      `${colors.dim}Files:  ${testFiles.length} test file(s)${colors.reset}\n`,
    );
  } else {
    console.log(`${colors.dim}File: ${testFiles[0]}${colors.reset}\n`);
  }

  const startDir = testFiles[0].substring(0, testFiles[0].lastIndexOf("/"));
  const { rootDir, configPath } = await findProjectConfig(startDir);

  const glubeanConfig = await loadConfig(rootDir, options.configFiles);
  const effectiveRun = mergeRunOptions(glubeanConfig.run, {
    verbose: options.verbose,
    pretty: options.pretty,
    logFile: options.logFile,
    emitFullTrace: options.emitFullTrace,
    inferSchema: options.inferSchema,
    truncateArrays: options.truncateArrays,
    envFile: options.envFile,
    failFast: options.failFast,
    failAfter: options.failAfter,
  });

  if (effectiveRun.logFile && !isMultiFile) {
    const logPath = getLogFilePath(testFiles[0]);
    console.log(`${colors.dim}Log file: ${logPath}${colors.reset}`);
  }

  // Resolve env file: --env-file flag > .glubean/active-env > config default > .env
  const userSpecifiedEnvFile = !!options.envFile;
  const envFileName = userSpecifiedEnvFile
    ? effectiveRun.envFile!
    : await resolveEnvFileName(rootDir);
  const envPath = resolve(rootDir, envFileName);

  if (userSpecifiedEnvFile) {
    try {
      await stat(envPath);
    } catch {
      console.error(
        `${colors.red}Error: env file '${envFileName}' not found in ${rootDir}${colors.reset}`,
      );
      process.exit(1);
    }
  }

  // Canonical env loading: reads both .env and .env.secrets, expands
  // `${NAME}` references (same file forward refs, cross-file refs, and
  // process.env fallback), splits back into {vars, secrets} with secrets
  // winning on collision. See @glubean/runner:loadProjectEnv.
  const { vars: envVars, secrets } = await loadProjectEnv(rootDir, envFileName);

  // Warn separately on the missing-secrets case so users get a visual
  // signal — loadProjectEnv itself treats missing files as silent empties.
  const secretsPath = resolve(rootDir, `${envFileName}.secrets`);
  let secretsExist = true;
  try {
    await stat(secretsPath);
  } catch {
    secretsExist = false;
  }
  if (!secretsExist && Object.keys(envVars).length > 0) {
    console.warn(
      `${colors.yellow}Warning: secrets file '${envFileName}.secrets' not found in ${rootDir}${colors.reset}`,
    );
  }

  if (Object.keys(envVars).length > 0) {
    console.log(
      `${colors.dim}Loaded ${Object.keys(envVars).length} vars from ${envFileName}${colors.reset}`,
    );
  }

  // ── Preflight: verify auth before running tests when --upload is set ────
  if (options.upload) {
    const { resolveToken, resolveProjectId, resolveApiUrl } = await import(
      "../lib/auth.js"
    );
    const authOpts = {
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
    };
    const sources = {
      envFileVars: { ...envVars, ...secrets },
      cloudConfig: glubeanConfig.cloud,
    };
    const preToken = await resolveToken(authOpts, sources);
    const preProject = await resolveProjectId(authOpts, sources);
    const preApiUrl = await resolveApiUrl(authOpts, sources);
    if (!preToken) {
      console.error(
        `${colors.red}Error: --upload requires authentication but no token found.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Run 'glubean login', set GLUBEAN_TOKEN, or add token to .env.secrets or package.json glubean.cloud.${colors.reset}`,
      );
      process.exit(1);
    }
    if (!preProject) {
      console.error(
        `${colors.red}Error: --upload requires a project ID but none found.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Use --project, set projectId in package.json glubean.cloud, or run 'glubean login'.${colors.reset}`,
      );
      process.exit(1);
    }
    try {
      const resp = await fetch(`${preApiUrl}/open/v1/whoami`, {
        headers: { Authorization: `Bearer ${preToken}` },
      });
      if (!resp.ok) {
        console.error(
          `${colors.red}Error: authentication failed (${resp.status}).${colors.reset}`,
        );
        if (resp.status === 401) {
          console.error(
            `${colors.dim}Token is invalid or expired. Run 'glubean login' to re-authenticate.${colors.reset}`,
          );
        }
        process.exit(1);
      }
      const identity = await resp.json() as { kind: string; projectName?: string };
      console.log(
        `${colors.dim}Authenticated as ${
          identity.kind === "project_token" ? `project token (${identity.projectName})` : "user"
        } · upload to ${preApiUrl}${colors.reset}`,
      );
    } catch (err) {
      console.error(
        `${colors.red}Error: cannot reach server at ${preApiUrl}${colors.reset}`,
      );
      console.error(
        `${colors.dim}${(err as Error).message}${colors.reset}`,
      );
      process.exit(1);
    }
  }

  // ── Discover tests across all files ─────────────────────────────────────
  console.log(`${colors.dim}Discovering tests...${colors.reset}`);
  const allFileTests: FileTest[] = [];
  let totalDiscovered = 0;

  for (const filePath of testFiles) {
    try {
      const tests = await discoverTests(filePath);
      for (const test of tests) {
        allFileTests.push({ filePath, exportName: test.exportName, test });
      }
      totalDiscovered += tests.length;
    } catch (error) {
      if (isMultiFile) {
        const relPath = relative(process.cwd(), filePath);
        console.error(
          `  ${colors.red}✗${colors.reset} ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        console.error(
          `\n${colors.red}❌ Failed to load test file${colors.reset}`,
        );
        console.error(
          `${colors.dim}${error instanceof Error ? error.message : String(error)}${colors.reset}`,
        );
        process.exit(1);
      }
    }
  }

  if (allFileTests.length === 0) {
    console.error(
      `\n${colors.red}❌ No test cases found${
        isMultiFile ? ` in ${testFiles.length} file(s)` : " in file"
      }${colors.reset}`,
    );
    console.error(
      `${colors.dim}Each test file must export tests: export const myTest = test("id")...${colors.reset}\n`,
    );
    process.exit(1);
  }

  if (isMultiFile) {
    const fileCounts = new Map<string, number>();
    for (const ft of allFileTests) {
      fileCounts.set(ft.filePath, (fileCounts.get(ft.filePath) || 0) + 1);
    }
    for (const [fp, count] of fileCounts) {
      const relPath = relative(process.cwd(), fp);
      console.log(
        `  ${colors.dim}${relPath} (${count} test${count === 1 ? "" : "s"})${colors.reset}`,
      );
    }
  }

  const hasOnly = allFileTests.some((ft) => ft.test.meta.only);
  if (hasOnly) {
    console.log(
      `${colors.yellow}ℹ️  Running only tests marked with .only${colors.reset}`,
    );
  }

  const hasTags = options.tags && options.tags.length > 0;
  const testsToRun = allFileTests.filter((ft) => {
    const tc = ft.test;
    if (tc.meta.skip) return false;
    if (hasOnly && !tc.meta.only) return false;
    if (options.filter && !matchesFilter(tc, options.filter)) return false;
    if (hasTags && !matchesTags(tc, options.tags!, options.tagMode)) return false;
    return true;
  });

  if (testsToRun.length === 0) {
    if (options.filter || hasTags) {
      const parts: string[] = [];
      if (options.filter) parts.push(`filter: "${options.filter}"`);
      if (hasTags) {
        const joiner = options.tagMode === "and" ? " AND " : " OR ";
        parts.push(`tag: ${options.tags!.join(joiner)}`);
      }
      console.error(
        `\n${colors.red}❌ No tests match ${parts.join(" + ")}${colors.reset}\n`,
      );
    } else {
      console.error(
        `\n${colors.red}❌ All tests skipped${colors.reset}\n`,
      );
    }
    process.exit(1);
  }

  if (options.filter || hasTags) {
    const parts: string[] = [];
    if (options.filter) parts.push(`filter: "${options.filter}"`);
    if (hasTags) {
      const joiner = options.tagMode === "and" ? " AND " : " OR ";
      parts.push(`tag: ${options.tags!.join(joiner)}`);
    }
    console.log(
      `${colors.dim}${parts.join(" + ")} (${testsToRun.length}/${totalDiscovered} tests)${colors.reset}`,
    );
  }

  console.log(
    `\n${colors.bold}Running ${testsToRun.length} test(s)...${colors.reset}\n`,
  );

  if (options.pick) {
    process.env.GLUBEAN_PICK = options.pick;
    console.log(`${colors.dim}  pick: ${options.pick}${colors.reset}`);
  } else {
    delete process.env.GLUBEAN_PICK;
  }

  const shared = toSharedRunConfig(effectiveRun);
  // Note: TestExecutor construction is delegated to ProjectRunner below
  // (it builds one via TestExecutor.fromSharedConfig with identical cwd +
  // inspectBrk params when no executor option is passed).
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let overallPeakMemoryMB = 0;
  const totalStartTime = Date.now();

  const collectedRuns: CollectedTestRun[] = [];
  const metricCollector = new MetricCollector();

  const runStats: RunSummaryStats = {
    httpRequestTotal: 0,
    httpErrorTotal: 0,
    assertionTotal: 0,
    assertionFailed: 0,
    warningTotal: 0,
    warningTriggered: 0,
    stepTotal: 0,
    stepPassed: 0,
    stepFailed: 0,
  };

  const failureLimit = effectiveRun.failAfter ??
    (effectiveRun.failFast ? 1 : undefined);

  const fileGroups = new Map<string, typeof testsToRun>();
  for (const entry of testsToRun) {
    const group = fileGroups.get(entry.filePath) || [];
    group.push(entry);
    fileGroups.set(entry.filePath, group);
  }

  // ── Session + execution + teardown via ProjectRunner ─────────────────────
  //
  // Replaces the prior inline RunOrchestrator + per-file TestExecutor loop
  // (~540 lines) with a single event-stream consumer. Per-event presentation
  // handlers (trace / assertion / step / etc.) are byte-for-byte unchanged;
  // only the outer wiring swaps from direct executor.run(...) to the facade.
  //
  // See internal/30-execution/2026-04-23-rf-1b-cli-migration/execution-log.md.

  const sessionState: Record<string, unknown> = {};

  const compactUrl = (url: string): string => {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || "");
    } catch {
      return url;
    }
  };

  const colorStatus = (status: number | string): string => {
    const n = typeof status === "number" ? status : Number.NaN;
    if (n >= 500) return `${colors.red}${status}${colors.reset}`;
    if (n >= 400) return `${colors.yellow}${status}${colors.reset}`;
    if (Number.isNaN(n)) return `${colors.dim}${status}${colors.reset}`;
    return `${colors.green}${status}${colors.reset}`;
  };

  // Per-test state, scoped across file:event boundaries. Reset on each
  // "start" event inside file:event handlers.
  let currentGroupFilePath = "";
  let currentTestMap: Map<string, (typeof testsToRun)[number]> | undefined;
  let testId = "";
  let testName = "";
  let testItem: (typeof testsToRun)[number]["test"] | null = null;
  let startTime = Date.now();
  let testEvents: ExecutionEvent[] = [];
  let assertions: Array<{
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
  }> = [];
  let success = false;
  let errorMsg: string | undefined;
  let peakMemoryMB: string | undefined;
  let stepAssertionCount = 0;
  let stepTraceLines: string[] = [];
  let testStarted = false;

  const addLogEntry = (
    type: LogEntry["type"],
    message: string,
    data?: unknown,
  ) => {
    if (effectiveRun.logFile) {
      logEntries.push({
        timestamp: new Date().toISOString(),
        testId,
        testName,
        type,
        message,
        data,
      });
    }
  };

  const finalizeTest = () => {
    if (!testStarted) return;
    testStarted = false;
    const duration = Date.now() - startTime;
    const allAssertionsPassed = assertions.every((a) => a.passed);
    const finalSuccess = success && allAssertionsPassed;

    collectedRuns.push({
      testId,
      testName,
      tags: testItem?.meta.tags,
      filePath: currentGroupFilePath,
      events: testEvents,
      success: finalSuccess,
      durationMs: duration,
      groupId: testItem?.meta.groupId,
    });

    addLogEntry("result", finalSuccess ? "PASSED" : "FAILED", {
      duration,
      success: finalSuccess,
      peakMemoryMB,
    });

    const peakMB = peakMemoryMB ? parseFloat(peakMemoryMB) : 0;
    if (peakMB > overallPeakMemoryMB) {
      overallPeakMemoryMB = peakMB;
    }

    const testHttpCalls = testEvents.filter((e) => e.type === "trace").length;
    const testSteps = testEvents.filter((e) => e.type === "step_end").length;
    const miniStats: string[] = [];
    miniStats.push(`${duration}ms`);
    if (testHttpCalls > 0) miniStats.push(`${testHttpCalls} calls`);
    if (assertions.length > 0) miniStats.push(`${assertions.length} checks`);
    if (testSteps > 0) miniStats.push(`${testSteps} steps`);

    if (finalSuccess) {
      console.log(
        `    ${colors.green}✓ PASSED${colors.reset} ${colors.dim}(${miniStats.join(", ")})${colors.reset}`,
      );
      passed++;
    } else {
      console.log(
        `    ${colors.red}✗ FAILED${colors.reset} ${colors.dim}(${miniStats.join(", ")})${colors.reset}`,
      );
      failed++;
    }

    if (peakMB > MEMORY_WARNING_THRESHOLD_MB) {
      if (peakMB > CLOUD_MEMORY_LIMITS.free) {
        console.log(
          `      ${colors.yellow}⚠ Memory (${peakMemoryMB} MB) exceeds Free cloud runner limit (${CLOUD_MEMORY_LIMITS.free} MB).${colors.reset}`,
        );
      } else {
        console.log(
          `      ${colors.yellow}⚠ Memory (${peakMemoryMB} MB) is approaching Free cloud runner limit (${CLOUD_MEMORY_LIMITS.free} MB).${colors.reset}`,
        );
      }
    }

    for (const assertion of assertions) {
      if (!assertion.passed) {
        console.log(
          `      ${colors.red}✗ ${assertion.message}${colors.reset}`,
        );
        if (assertion.expected !== undefined || assertion.actual !== undefined) {
          if (assertion.expected !== undefined) {
            console.log(
              `        ${colors.dim}Expected: ${JSON.stringify(assertion.expected)}${colors.reset}`,
            );
          }
          if (assertion.actual !== undefined) {
            console.log(
              `        ${colors.dim}Actual:   ${JSON.stringify(assertion.actual)}${colors.reset}`,
            );
          }
        }
      }
    }

    if (errorMsg) {
      console.log(`      ${colors.red}Error: ${errorMsg}${colors.reset}`);
    }
  };

  // Pre-filter tests by capability profile so file:start can emit the
  // ⊘ lines inline (preserves the pre-migration output layout where these
  // lines appear between the file header and the first runnable test of
  // the file). `runnableByFile` is what actually feeds ProjectRunner.
  const fileCapabilitySkips = new Map<
    string,
    Array<{ ft: (typeof testsToRun)[number]; reason: string }>
  >();
  const runnableByFile = new Map<string, typeof testsToRun>();
  for (const [filePath, fileTests] of fileGroups) {
    const skips: Array<{ ft: (typeof testsToRun)[number]; reason: string }> = [];
    const runnable: typeof testsToRun = [];
    for (const ft of fileTests) {
      const reason = shouldSkipTest(ft.test.meta, capabilityProfile);
      if (reason) {
        skips.push({ ft, reason });
      } else {
        runnable.push(ft);
      }
    }
    if (skips.length > 0) fileCapabilitySkips.set(filePath, skips);
    if (runnable.length > 0) runnableByFile.set(filePath, runnable);
  }

  // Flatten in fileGroups insertion order so ProjectRunner processes files
  // in the same order the old inline loop did.
  const runnableTests: typeof testsToRun = [];
  for (const filePath of fileGroups.keys()) {
    const runnable = runnableByFile.get(filePath);
    if (runnable) runnableTests.push(...runnable);
  }

  // Files ProjectRunner actually started. Any fileGroups entry that never
  // gets file:start is a fail-fast skip — handled post run:complete.
  const startedFiles = new Set<string>();

  const runner = new ProjectRunner({
    rootDir,
    sharedConfig: shared,
    sessionStartDir: startDir,
    vars: envVars,
    secrets,
    // Cast — CLI's DiscoveredTestMeta.requires is a plain `string | undefined`
    // (scanner output, openly typed). ProjectRunnerTest narrows it to the
    // CaseRequires literal union. Widening happens upstream at scanner.
    tests: runnableTests.map((t) => ({
      filePath: t.filePath,
      exportName: t.exportName,
      meta: t.test.meta,
    })) as ProjectRunnerTest[],
    noSession: !!options.noSession,
    interactive,
    ...(options.inspectBrk !== undefined && { inspectBrk: options.inspectBrk }),
    metricCollector,
  });

  for await (const ev of runner.run()) {
    switch (ev.type) {
      case "bootstrap:start":
      case "bootstrap:done":
      case "discovery:done":
      case "session:setup:start":
      case "session:teardown:start":
      case "session:teardown:done":
        // Silent — either internal plumbing, or already covered by a more
        // specific event (e.g. session:discovered already printed the
        // "Session: <path>" header before setup:start arrived).
        break;

      case "bootstrap:failed":
        console.error(
          `\n${colors.red}Bootstrap failed: ${ev.error.message}${colors.reset}`,
        );
        process.exit(1);
        break;

      case "session:discovered":
        if (ev.sessionFile) {
          console.log(
            `${colors.dim}Session: ${relative(process.cwd(), ev.sessionFile)}${colors.reset}`,
          );
        }
        break;

      case "session:setup:event": {
        const se = ev.event;
        if (se.type === "session:set") {
          sessionState[se.key] = se.value;
        } else if (se.type === "status" && se.status === "failed") {
          console.log(
            `  ${colors.red}✗ Session setup failed${se.error ? `: ${se.error}` : ""}${colors.reset}`,
          );
        } else if (se.type === "log") {
          console.log(
            `  ${colors.dim}[session] ${se.message}${colors.reset}`,
          );
        }
        break;
      }

      case "session:setup:done": {
        const count = ev.stateKeys.length;
        if (count > 0) {
          console.log(
            `${colors.dim}  ${count} session value${count > 1 ? "s" : ""} set${colors.reset}`,
          );
        }
        break;
      }

      case "session:setup:failed":
        console.log(
          `\n${colors.red}Session setup failed. All tests skipped.${colors.reset}`,
        );
        process.exit(1);
        break;

      case "session:teardown:event": {
        const te = ev.event;
        if (te.type === "log") {
          console.log(
            `  ${colors.dim}[session] ${te.message}${colors.reset}`,
          );
        } else if (te.type === "status" && te.status === "failed") {
          console.log(
            `  ${colors.yellow}⚠ Session teardown failed${te.error ? `: ${te.error}` : ""}${colors.reset}`,
          );
        }
        break;
      }

      case "file:start": {
        currentGroupFilePath = ev.filePath;
        startedFiles.add(ev.filePath);
        const runnable = runnableByFile.get(ev.filePath) ?? [];
        currentTestMap = new Map(runnable.map((ft) => [ft.test.meta.id, ft]));

        if (isMultiFile) {
          const relPath = relative(process.cwd(), ev.filePath);
          console.log(`${colors.bold}📁 ${relPath}${colors.reset}`);
        }

        // Inline capability-skip display — preserves pre-migration layout
        // where ⊘ lines sit between the file header and the first runnable
        // test of the file.
        const skips = fileCapabilitySkips.get(ev.filePath);
        if (skips) {
          for (const { ft, reason } of skips) {
            skipped++;
            const name = ft.test.meta.name || ft.test.meta.id;
            console.log(
              `  ${colors.yellow}⊘${colors.reset} ${name} ${colors.dim}— skipped (${reason})${colors.reset}`,
            );
            collectedRuns.push({
              testId: ft.test.meta.id,
              testName: name,
              tags: ft.test.meta.tags as string[] | undefined,
              filePath: ev.filePath,
              events: [{ type: "status", status: "skipped", reason } as ExecutionEvent],
              success: true,
              durationMs: 0,
              groupId: ft.test.meta.groupId,
            });
          }
        }
        break;
      }

      case "file:event": {
        const event = ev.event;
        switch (event.type) {
          case "start": {
            const entry = currentTestMap?.get(event.id);
            testId = event.id;
            testName = entry?.test.meta.name || event.name || event.id;
            testItem = entry?.test || null;
            startTime = Date.now();
            testEvents = [];
            assertions = [];
            success = false;
            errorMsg = undefined;
            peakMemoryMB = undefined;
            stepAssertionCount = 0;
            stepTraceLines = [];
            testStarted = true;

            const tags = testItem?.meta.tags?.length
              ? ` ${colors.dim}[${testItem.meta.tags.join(", ")}]${colors.reset}`
              : "";
            console.log(
              `  ${colors.cyan}●${colors.reset} ${testName}${tags}`,
            );
            if (testItem?.meta.description) {
              console.log(
                `    ${colors.dim}${testItem.meta.description}${colors.reset}`,
              );
            }
            break;
          }

          case "status":
            success = event.status === "completed";
            if (event.error) {
              errorMsg = event.error;
              addLogEntry("error", event.error);
            }
            if (event.peakMemoryMB) peakMemoryMB = event.peakMemoryMB;
            finalizeTest();
            break;

          case "error":
            success = false;
            if (!errorMsg) errorMsg = event.message;
            addLogEntry("error", event.message);
            break;

          case "log":
            addLogEntry("log", event.message);
            if (event.message.startsWith("Loading test module:")) break;
            console.log(`      ${colors.dim}${event.message}${colors.reset}`);
            break;

          case "assertion":
            assertions.push({
              passed: event.passed,
              message: event.message,
              actual: event.actual,
              expected: event.expected,
            });
            stepAssertionCount++;
            addLogEntry("assertion", event.message, {
              passed: event.passed,
              actual: event.actual,
              expected: event.expected,
            });
            if (effectiveRun.verbose) {
              const icon = event.passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
              console.log(
                `        ${icon} ${colors.dim}${event.message}${colors.reset}`,
              );
            }
            break;

          case "trace": {
            const traceTarget = event.data.target ?? `${event.data.method ?? "?"} ${event.data.url ?? "?"}`;
            const traceDuration = event.data.durationMs ?? event.data.duration ?? 0;
            const traceProtocol = event.data.protocol ?? "http";
            const traceMsg = `${traceTarget} → ${event.data.status} (${traceDuration}ms)`;
            addLogEntry("trace", traceMsg, event.data);
            traceCollector.push({
              testId,
              protocol: traceProtocol,
              target: traceTarget,
              method: event.data.method,
              url: event.data.url,
              status: event.data.status,
            });
            const displayTarget = event.data.method && event.data.url
              ? `${colors.dim}${event.data.method}${colors.reset} ${compactUrl(event.data.url)}`
              : `${colors.dim}${traceTarget}${colors.reset}`;
            const compactTrace = `${displayTarget} ${colors.dim}→${colors.reset} ${
              colorStatus(event.data.status)
            } ${colors.dim}${traceDuration}ms${colors.reset}`;
            stepTraceLines.push(compactTrace);
            console.log(
              `      ${colors.dim}↳${colors.reset} ${compactTrace}`,
            );
            if (effectiveRun.verbose && event.data.requestBody) {
              console.log(
                `        ${colors.dim}req: ${JSON.stringify(event.data.requestBody).slice(0, 120)}${colors.reset}`,
              );
            }
            if (effectiveRun.verbose && event.data.responseBody) {
              const body = JSON.stringify(event.data.responseBody);
              console.log(
                `        ${colors.dim}res: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}${colors.reset}`,
              );
            }
            break;
          }

          case "action": {
            const a = event.data;
            if (a.category === "http:request") break;
            const statusColor = a.status === "ok" ? colors.green : a.status === "error" ? colors.red : colors.yellow;
            const statusIcon = a.status === "ok" ? "✓" : a.status === "error" ? "✗" : "⏱";
            addLogEntry("action", `[${a.category}] ${a.target} ${a.duration}ms ${a.status}`, a);
            console.log(
              `      ${colors.dim}↳${colors.reset} ${colors.cyan}${a.category}${colors.reset} ${a.target} ${colors.dim}${a.duration}ms${colors.reset} ${statusColor}${statusIcon}${colors.reset}`,
            );
            break;
          }

          case "event": {
            const evData = event.data;
            addLogEntry("event", `[${evData.type}]`, evData);
            if (effectiveRun.verbose) {
              const summary = JSON.stringify(evData.data).slice(0, 80);
              console.log(
                `      ${colors.dim}[${evData.type}] ${summary}${colors.reset}`,
              );
            }
            break;
          }

          case "metric": {
            // ProjectRunner already accumulates into metricCollector (passed
            // in above). CLI only handles verbose display + log entry.
            const unit = event.unit ? ` ${event.unit}` : "";
            const tagStr = event.tags
              ? ` ${colors.dim}{${
                Object.entries(event.tags)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")
              }}${colors.reset}`
              : "";
            const metricMsg = `${event.name} = ${event.value}${unit}`;
            addLogEntry("metric", metricMsg, {
              name: event.name,
              value: event.value,
              unit: event.unit,
              tags: event.tags,
            });
            if (effectiveRun.verbose) {
              console.log(
                `      ${colors.blue}📊 ${metricMsg}${colors.reset}${tagStr}`,
              );
            }
            break;
          }

          case "step_start":
            stepAssertionCount = 0;
            stepTraceLines = [];
            console.log(
              `    ${colors.cyan}┌${colors.reset} ${colors.dim}step ${
                event.index + 1
              }/${event.total}${colors.reset} ${colors.bold}${event.name}${colors.reset}`,
            );
            break;

          case "step_end": {
            const stepIcon = event.status === "passed"
              ? `${colors.green}✓${colors.reset}`
              : event.status === "failed"
              ? `${colors.red}✗${colors.reset}`
              : `${colors.yellow}○${colors.reset}`;
            const stepParts: string[] = [];
            if (event.durationMs !== undefined) stepParts.push(`${event.durationMs}ms`);
            if (event.assertions > 0) stepParts.push(`${event.assertions} assertions`);
            const httpInStep = stepTraceLines.length;
            if (httpInStep > 0) stepParts.push(`${httpInStep} API call${httpInStep > 1 ? "s" : ""}`);
            console.log(
              `    ${colors.cyan}└${colors.reset} ${stepIcon} ${colors.dim}${stepParts.join(" · ")}${colors.reset}`,
            );
            if (event.error) {
              console.log(
                `      ${colors.red}${event.error}${colors.reset}`,
              );
            }
            break;
          }

          case "summary":
            runStats.httpRequestTotal += event.data.httpRequestTotal;
            runStats.httpErrorTotal += event.data.httpErrorTotal;
            runStats.assertionTotal += event.data.assertionTotal;
            runStats.assertionFailed += event.data.assertionFailed;
            runStats.warningTotal += event.data.warningTotal;
            runStats.warningTriggered += event.data.warningTriggered;
            runStats.stepTotal += event.data.stepTotal;
            runStats.stepPassed += event.data.stepPassed;
            runStats.stepFailed += event.data.stepFailed;
            break;

          case "warning": {
            const warnIcon = event.condition ? `${colors.green}✓${colors.reset}` : `${colors.yellow}⚠${colors.reset}`;
            console.log(
              `      ${warnIcon} ${colors.yellow}${event.message}${colors.reset}`,
            );
            break;
          }

          case "schema_validation":
            if (effectiveRun.verbose) {
              const icon = event.success ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
              console.log(
                `      ${icon} ${colors.dim}schema: ${event.label}${colors.reset}`,
              );
            }
            break;

          case "session:set":
            // ProjectRunner accumulates internally for cross-file forwarding;
            // CLI keeps its copy only for symmetry with pre-migration code
            // paths (useful e.g. for debug logging).
            sessionState[event.key] = event.value;
            continue;
        }

        if (testStarted) testEvents.push(event);
        break;
      }

      case "file:complete":
        // Mirror the old inline loop's tail cleanup: if the harness died
        // mid-test or emitted no start event, promote the leftover state
        // to a visible failure row.
        if (!testStarted && errorMsg) {
          console.log(
            `  ${colors.red}✗ ${errorMsg}${colors.reset}`,
          );
          failed++;
        }
        if (testStarted) {
          if (!errorMsg) errorMsg = "Process exited before test completed";
          finalizeTest();
        }
        break;

      case "run:complete":
        // Fail-fast skip display: any file ProjectRunner never started
        // (because the failure limit kicked in between file groups) gets
        // the old "○ (skipped — fail-fast)" lines here, preserving the
        // pre-migration output layout.
        if (failureLimit !== undefined && ev.failedCount >= failureLimit) {
          for (const [filePath, fileTests] of fileGroups) {
            if (startedFiles.has(filePath)) continue;
            if (isMultiFile) {
              const relPath = relative(process.cwd(), filePath);
              console.log(`${colors.bold}📁 ${relPath}${colors.reset}`);
            }
            for (const { test } of fileTests) {
              skipped++;
              const name = test.meta.name || test.meta.id;
              console.log(
                `  ${colors.yellow}○${colors.reset} ${name} ${colors.dim}(skipped — fail-fast)${colors.reset}`,
              );
            }
          }
        }
        break;

      case "run:failed":
        // Terminal failure — actual exit already happened in
        // bootstrap:failed / session:setup:failed above.
        break;
    }
  }

  const totalDurationMs = Date.now() - totalStartTime;

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(
    `\n${colors.bold}─────────────────────────────────────${colors.reset}`,
  );
  const summaryParts = [];
  if (passed > 0) summaryParts.push(`${colors.green}${passed} passed${colors.reset}`);
  if (failed > 0) summaryParts.push(`${colors.red}${failed} failed${colors.reset}`);
  if (skipped > 0) summaryParts.push(`${colors.yellow}${skipped} skipped${colors.reset}`);
  console.log(`${colors.bold}Tests:${colors.reset}  ${summaryParts.join(", ")}`);
  console.log(`${colors.bold}Total:${colors.reset}  ${passed + failed + skipped}`);
  if (overallPeakMemoryMB > 0) {
    const memColor = overallPeakMemoryMB > MEMORY_WARNING_THRESHOLD_MB ? colors.yellow : colors.dim;
    console.log(
      `${colors.bold}Memory:${colors.reset} ${memColor}${overallPeakMemoryMB.toFixed(2)} MB peak${colors.reset}`,
    );
  }

  const hasStats = runStats.httpRequestTotal > 0 || runStats.assertionTotal > 0 || runStats.stepTotal > 0;
  if (hasStats) {
    const parts: string[] = [];
    if (runStats.httpRequestTotal > 0) {
      const errPart = runStats.httpErrorTotal > 0
        ? ` ${colors.red}(${runStats.httpErrorTotal} errors)${colors.reset}` : "";
      parts.push(`${runStats.httpRequestTotal} API calls${errPart}`);
    }
    if (runStats.assertionTotal > 0) {
      const failPart = runStats.assertionFailed > 0
        ? ` ${colors.red}(${runStats.assertionFailed} failed)${colors.reset}` : "";
      parts.push(`${runStats.assertionTotal} assertions${failPart}`);
    }
    if (runStats.stepTotal > 0) parts.push(`${runStats.stepTotal} steps`);
    if (runStats.warningTriggered > 0) parts.push(`${colors.yellow}${runStats.warningTriggered} warnings${colors.reset}`);
    console.log(`${colors.bold}Stats:${colors.reset}  ${colors.dim}${parts.join("  ·  ")}${colors.reset}`);
  }

  // ── Threshold evaluation ──────────────────────────────────────────────────
  let thresholdSummary: import("@glubean/sdk").ThresholdSummary | undefined;
  if (glubeanConfig.thresholds && Object.keys(glubeanConfig.thresholds).length > 0) {
    thresholdSummary = evaluateThresholds(glubeanConfig.thresholds, metricCollector);
    const { results: thresholdResults, pass: allPass } = thresholdSummary;

    if (thresholdResults.length > 0) {
      console.log(`${colors.bold}Thresholds:${colors.reset}`);
      for (const r of thresholdResults) {
        const icon = r.pass ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
        const actualStr = Number.isNaN(r.actual) ? "N/A" : String(r.actual);
        console.log(`  ${icon} ${r.metric}.${r.aggregation} ... ${actualStr} ${r.threshold}`);
      }
      const tPassed = thresholdResults.filter((r) => r.pass).length;
      const statusColor = allPass ? colors.green : colors.red;
      console.log(`  ${statusColor}${tPassed}/${thresholdResults.length} passed${colors.reset}`);
    }
  }

  console.log();

  // Write log file
  if (effectiveRun.logFile && logEntries.length > 0) {
    const logPath = isMultiFile ? resolve(process.cwd(), "glubean-run.log") : getLogFilePath(testFiles[0]);
    const stringify = (value: unknown): string => {
      if (effectiveRun.pretty) {
        const pretty = JSON.stringify(value, null, 2);
        return pretty.split("\n").join("\n    ");
      }
      return JSON.stringify(value);
    };

    const logContent = [
      `# Glubean Test Log`,
      `# Target: ${isMultiFile ? resolve(target) : testFiles[0]}`,
      `# Run at: ${runStartTime}`,
      `# Tests: ${passed} passed, ${failed} failed`,
      ``,
      ...logEntries.map((entry) => {
        const prefix = `[${entry.timestamp}] [${entry.testId}]`;
        if (entry.type === "result") {
          return `${prefix} ${entry.message} (${(entry.data as { duration: number }).duration}ms)`;
        }
        if (entry.type === "assertion") {
          const data = entry.data as { passed: boolean; actual?: unknown; expected?: unknown };
          const status = data.passed ? "✓" : "✗";
          let line = `${prefix} [ASSERT ${status}] ${entry.message}`;
          if (data.expected !== undefined || data.actual !== undefined) {
            if (data.expected !== undefined) line += `\n    Expected: ${stringify(data.expected)}`;
            if (data.actual !== undefined) line += `\n    Actual:   ${stringify(data.actual)}`;
          }
          return line;
        }
        if (entry.type === "trace") {
          const data = entry.data as { requestBody?: unknown; responseBody?: unknown };
          let line = `${prefix} [TRACE] ${entry.message}`;
          if (data.requestBody !== undefined) line += `\n    Request Body: ${stringify(data.requestBody)}`;
          if (data.responseBody !== undefined) line += `\n    Response Body: ${stringify(data.responseBody)}`;
          return line;
        }
        if (entry.type === "metric") {
          const data = entry.data as { tags?: Record<string, string> };
          let line = `${prefix} [METRIC] ${entry.message}`;
          if (data.tags && Object.keys(data.tags).length > 0) line += `\n    Tags: ${stringify(data.tags)}`;
          return line;
        }
        if (entry.type === "error") return `${prefix} [ERROR] ${entry.message}`;
        return `${prefix} [LOG] ${entry.message}`;
      }),
      ``,
    ].join("\n");

    await writeFile(logPath, logContent, "utf-8");
    console.log(`${colors.dim}Log written to: ${logPath}${colors.reset}\n`);
  }

  // Write .glubean/traces.json
  if (traceCollector.length > 0) {
    try {
      const glubeanDir = resolve(rootDir, ".glubean");
      await mkdir(glubeanDir, { recursive: true });
      const tracesPath = resolve(glubeanDir, "traces.json");
      const traceSummary = {
        runAt: runStartTime,
        target,
        files: testFiles.map((f) => relative(process.cwd(), f)),
        traces: traceCollector,
      };
      await writeFile(tracesPath, JSON.stringify(traceSummary, null, 2), "utf-8");
    } catch {
      // Non-critical
    }
  }

  // ── Result JSON output ───────────────────────────────────────────────────
  const runContext = {
    ...buildRunContext(),
    command: process.argv.slice(2).join(" "),
    cwd: process.cwd(),
    ...(effectiveRun.envFile && { envFile: effectiveRun.envFile }),
  };

  const resultPayload = {
    context: runContext,
    target,
    files: testFiles.map((f) => relative(process.cwd(), f)),
    runAt: runStartLocal,
    summary: {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: totalDurationMs,
      stats: runStats,
    },
    tests: collectedRuns.map((r) => ({
      testId: r.testId,
      testName: r.testName,
      tags: r.tags,
      success: r.success,
      durationMs: r.durationMs,
      events: r.events,
    })),
    ...(thresholdSummary && { thresholds: thresholdSummary }),
    ...(options.meta && Object.keys(options.meta).length > 0 && { customMetadata: options.meta }),
  };
  const resultJson = JSON.stringify(resultPayload, null, 2);

  try {
    const glubeanDir = resolve(rootDir, ".glubean");
    await mkdir(glubeanDir, { recursive: true });
    await writeFile(resolve(glubeanDir, "last-run.result.json"), resultJson, "utf-8");
  } catch {
    // Non-critical
  }

  if (options.resultJson) {
    const resultPath = typeof options.resultJson === "string"
      ? resolveOutputPath(options.resultJson, process.cwd())
      : isMultiFile
      ? resolve(process.cwd(), "glubean-run.result.json")
      : getLogFilePath(testFiles[0]).replace(/\.log$/, ".result.json");
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, resultJson, "utf-8");
    console.log(`${colors.dim}Result written to: ${resultPath}${colors.reset}`);
    console.log(
      `${colors.dim}Open ${colors.reset}${colors.cyan}https://glubean.com/viewer${colors.reset}${colors.dim} to visualize it${colors.reset}\n`,
    );
  }

  // ── JUnit XML output ───────────────────────────────────────────────────
  if (options.reporter === "junit") {
    const junitPath = options.reporterPath
      ? resolveOutputPath(options.reporterPath, process.cwd())
      : isMultiFile
      ? resolve(process.cwd(), "glubean-run.junit.xml")
      : getLogFilePath(testFiles[0]).replace(/\.log$/, ".junit.xml");
    const summaryData = {
      total: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: totalDurationMs,
    };
    const xml = toJunitXml(collectedRuns, target, summaryData);
    await mkdir(dirname(junitPath), { recursive: true });
    await writeFile(junitPath, xml, "utf-8");
    console.log(
      `${colors.dim}JUnit XML written to: ${junitPath}${colors.reset}\n`,
    );
  }

  // ── Write .trace.jsonc files ──
  if (effectiveRun.emitFullTrace) {
    try {
      await writeTraceFiles(collectedRuns, rootDir, effectiveRun.envFile, options.traceLimit);
    } catch {
      // Non-critical
    }
  }

  // ── Screenshot paths ──────────────────────────────────────────────────
  {
    const screenshotPaths: string[] = [];
    for (const run of collectedRuns) {
      for (const event of run.events) {
        if (event.type !== "event") continue;
        const ev = event.data as { type?: string; data?: Record<string, unknown> };
        if (ev.type === "browser:screenshot" && typeof ev.data?.path === "string") {
          screenshotPaths.push(resolve(rootDir, ev.data.path));
        }
      }
    }
    if (screenshotPaths.length > 0) {
      for (const p of screenshotPaths) {
        console.log(`${colors.dim}Screenshot: ${colors.reset}${p}`);
      }
      console.log();
    }
  }

  // ── Cloud upload ────────────────────────────────────────────────────────
  if (options.upload) {
    const { resolveToken, resolveProjectId, resolveApiUrl } = await import("../lib/auth.js");
    const { uploadToCloud } = await import("../lib/upload.js");

    const authOpts = {
      token: options.token,
      project: options.project,
      apiUrl: options.apiUrl,
    };
    const sources = {
      envFileVars: { ...envVars, ...secrets },
      cloudConfig: glubeanConfig.cloud,
    };
    const token = await resolveToken(authOpts, sources);
    const projectId = await resolveProjectId(authOpts, sources);
    const apiUrl = await resolveApiUrl(authOpts, sources);

    if (!token) {
      console.error(`${colors.red}Upload failed: no auth token found.${colors.reset}`);
      process.exit(1);
    } else if (!projectId) {
      console.error(`${colors.red}Upload failed: no project ID.${colors.reset}`);
      process.exit(1);
    } else {
      const { compileScopes, redactEvent, BUILTIN_SCOPES } = await import("@glubean/redaction");
      const compiledScopes = compileScopes({
        builtinScopes: BUILTIN_SCOPES,
        globalRules: glubeanConfig.redaction.globalRules,
        replacementFormat: glubeanConfig.redaction.replacementFormat,
      });

      // Generate metadata for test registry
      let metadata: UploadResultPayload['metadata'] | undefined;
      try {
        const { scan } = await import("@glubean/scanner");
        const { buildMetadata } = await import("../metadata.js");
        const scanResult = await scan(rootDir);
        const built = await buildMetadata(scanResult, {
          generatedBy: `@glubean/cli@${CLI_VERSION}`,
          projectId,
        });
        metadata = built;
      } catch {
        // Non-critical: upload results without metadata
      }

      const redactedPayload = {
        ...resultPayload,
        metadata,
        tests: resultPayload.tests.map((t) => ({
          ...t,
          events: t.events.map((e) => redactEvent(e, compiledScopes, glubeanConfig.redaction.replacementFormat)),
        })),
      };

      await uploadToCloud(redactedPayload, {
        apiUrl,
        token,
        projectId,
        envFile: effectiveRun.envFile,
        rootDir,
      });
    }
  }

  if (failed > 0 || (thresholdSummary && !thresholdSummary.pass)) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// JUnit XML generation
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toJunitXml(
  collectedRuns: CollectedTestRun[],
  target: string,
  summary: { total: number; passed: number; failed: number; skipped: number; durationMs: number },
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(target)}" tests="${summary.total}" failures="${summary.failed}" skipped="${summary.skipped}" time="${(summary.durationMs / 1000).toFixed(3)}">`,
  ];

  for (const run of collectedRuns) {
    const classname = run.filePath ? escapeXml(relative(process.cwd(), run.filePath).replace(/\\/g, "/")) : "glubean";
    const name = escapeXml(run.testName);
    const time = (run.durationMs / 1000).toFixed(3);

    if (run.success) {
      lines.push(`  <testcase classname="${classname}" name="${name}" time="${time}" />`);
    } else {
      const statusEvent = run.events.find(
        (e) => e.type === "status" && "error" in e,
      ) as { type: "status"; error?: string } | undefined;
      const failedAssertions = run.events
        .filter((e) => e.type === "assertion" && !("passed" in e && (e as { passed: boolean }).passed))
        .map((e) => ("message" in e ? (e as { message: string }).message : ""))
        .filter(Boolean);
      const message = statusEvent?.error || failedAssertions[0] || "Test failed";
      const detail = failedAssertions.length > 0 ? failedAssertions.join("\n") : message;
      lines.push(`  <testcase classname="${classname}" name="${name}" time="${time}">`);
      lines.push(`    <failure message="${escapeXml(message)}">${escapeXml(detail)}</failure>`);
      lines.push(`  </testcase>`);
    }
  }

  lines.push("</testsuite>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Trace file generation
// ---------------------------------------------------------------------------

const TRACE_HISTORY_LIMIT = 20;

function p2(n: number): string {
  return String(n).padStart(2, "0");
}

function sanitizeForPath(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "_");
}

function localTimeString(d: Date): string {
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

async function writeTraceFiles(
  collectedRuns: CollectedTestRun[],
  rootDir: string,
  envFile?: string,
  traceLimit?: number,
): Promise<void> {
  const limit = traceLimit ?? TRACE_HISTORY_LIMIT;
  const now = new Date();
  const ts = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
    `T${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const envLabel = envFile || ".env";

  for (const run of collectedRuns) {
    const pairs: Array<{
      request: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
      response: { status: number; statusText?: string; durationMs: number; headers?: Record<string, string>; body?: unknown };
    }> = [];

    for (const event of run.events) {
      if (event.type !== "trace") continue;
      const d = event.data;
      pairs.push({
        request: {
          method: d.method ?? "?",
          url: d.url ?? d.target ?? "?",
          ...(d.requestHeaders && Object.keys(d.requestHeaders).length > 0 ? { headers: d.requestHeaders } : {}),
          ...(d.requestBody !== undefined ? { body: d.requestBody } : {}),
        },
        response: {
          status: typeof d.status === "number" ? d.status : 0,
          durationMs: d.durationMs ?? d.duration ?? 0,
          ...(d.responseHeaders && Object.keys(d.responseHeaders).length > 0 ? { headers: d.responseHeaders } : {}),
          ...(d.responseBody !== undefined ? { body: d.responseBody } : {}),
        },
      });
    }

    if (pairs.length === 0) continue;

    const fileName = basename(run.filePath).replace(/\.ts$/, "");
    const dirId = sanitizeForPath(run.groupId ?? run.testId);
    const tracesDir = resolve(rootDir, ".glubean", "traces", fileName, dirId);
    await mkdir(tracesDir, { recursive: true });

    const traceName = (run.groupId && run.groupId !== run.testId) ? `${ts}--${sanitizeForPath(run.testId)}` : ts;
    const traceFilePath = resolve(tracesDir, `${traceName}.trace.jsonc`);

    const relFile = relative(rootDir, run.filePath);
    const header = [
      `// ${relFile} → ${run.testId} — ${pairs.length} HTTP call${pairs.length > 1 ? "s" : ""}`,
      `// Run at: ${localTimeString(now)}`,
      `// Environment: ${envLabel}`,
      "",
    ].join("\n");

    const content = header + JSON.stringify(pairs, null, 2) + "\n";
    await writeFile(traceFilePath, content, "utf-8");

    console.log(`${colors.dim}Trace: ${colors.reset}${traceFilePath}`);

    await cleanupTraceDir(tracesDir, limit);
  }
}

async function cleanupTraceDir(dir: string, limit: number): Promise<void> {
  try {
    const entries = await readdir(dir);
    const traceFiles = entries.filter((name) => name.endsWith(".trace.jsonc")).sort().reverse();
    for (const name of traceFiles.slice(limit)) {
      await rm(resolve(dir, name)).catch(() => {});
    }
  } catch {
    // Cleanup is best-effort
  }
}
