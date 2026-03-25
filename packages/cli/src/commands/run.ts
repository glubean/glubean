import {
  createContextWithSession,
  discoverSessionFile,
  evaluateThresholds,
  type ExecutionEvent,
  MetricCollector,
  normalizePositiveTimeoutMs,
  RunOrchestrator,
  TestExecutor,
  toSingleExecutionOptions,
  buildRunContext,
} from "@glubean/runner";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { stat, readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { glob } from "node:fs/promises";
import { loadConfig, mergeRunOptions, toSharedRunConfig } from "../lib/config.js";
import { loadEnvFile } from "../lib/env.js";
import { resolveEnvFileName } from "../lib/active_env.js";
import { CLI_VERSION } from "../version.js";
import type { UploadResultPayload } from "../lib/upload.js";
import { extractFromSource } from "@glubean/scanner/static";

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
  upload?: boolean;
  project?: string;
  token?: string;
  apiUrl?: string;
  noSession?: boolean;
  meta?: Record<string, string>;
}

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

async function walkTestFiles(dir: string, result: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_SKIP_DIRS.includes(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
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
      if (full.endsWith(".test.ts")) {
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
  tags?: string[];
  timeout?: number;
  skip?: boolean;
  only?: boolean;
  groupId?: string;
  parallel?: boolean;
}

interface DiscoveredTest {
  exportName: string;
  meta: DiscoveredTestMeta;
}

async function discoverTests(filePath: string): Promise<DiscoveredTest[]> {
  const content = await readFile(filePath, "utf-8");
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

  const traceCollector: Array<{
    testId: string;
    method: string;
    url: string;
    status: number;
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
      `${colors.dim}Glubean looks for files matching *.test.ts in the target directory.${colors.reset}`,
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

  const envVars = await loadEnvFile(envPath);

  const secretsPath = resolve(rootDir, `${envFileName}.secrets`);
  let secretsExist = true;
  try {
    await stat(secretsPath);
  } catch {
    secretsExist = false;
  }
  const secrets = secretsExist ? await loadEnvFile(secretsPath) : {};

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
  const executor = TestExecutor.fromSharedConfig(shared, {
    cwd: rootDir,
    ...(options.inspectBrk && { inspectBrk: options.inspectBrk }),
  });
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

  // ── Session discovery and setup ───────────────────────────────────────────
  const sessionState: Record<string, unknown> = {};
  const sessionFile = options.noSession
    ? undefined
    : discoverSessionFile(startDir, rootDir);
  const orchestrator = new RunOrchestrator(executor);

  if (sessionFile) {
    console.log(
      `${colors.dim}Session: ${relative(process.cwd(), sessionFile)}${colors.reset}`,
    );
    let sessionFailed = false;

    for await (const event of orchestrator.runSessionSetup(
      sessionFile,
      { vars: envVars, secrets },
      toSingleExecutionOptions(shared),
    )) {
      if (event.type === "session:set") {
        sessionState[event.key] = event.value;
      } else if (event.type === "status" && event.status === "failed") {
        sessionFailed = true;
        console.log(
          `  ${colors.red}✗ Session setup failed${event.error ? `: ${event.error}` : ""}${colors.reset}`,
        );
      } else if (event.type === "log") {
        console.log(
          `  ${colors.dim}[session] ${event.message}${colors.reset}`,
        );
      }
    }

    if (sessionFailed) {
      // Best-effort teardown before exiting
      for await (const _event of orchestrator.runSessionTeardown(
        sessionFile,
        { vars: envVars, secrets },
        sessionState,
        toSingleExecutionOptions(shared),
      )) {
        // Silently consume teardown events
      }
      console.log(
        `\n${colors.red}Session setup failed. All tests skipped.${colors.reset}`,
      );
      process.exit(1);
    }

    const keyCount = Object.keys(sessionState).length;
    if (keyCount > 0) {
      console.log(
        `${colors.dim}  ${keyCount} session value${keyCount > 1 ? "s" : ""} set${colors.reset}`,
      );
    }
  }

  const compactUrl = (url: string): string => {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || "");
    } catch {
      return url;
    }
  };

  const colorStatus = (status: number): string => {
    if (status >= 500) return `${colors.red}${status}${colors.reset}`;
    if (status >= 400) return `${colors.yellow}${status}${colors.reset}`;
    return `${colors.green}${status}${colors.reset}`;
  };

  for (const [groupFilePath, fileTests] of fileGroups) {
    if (isMultiFile) {
      const relPath = relative(process.cwd(), groupFilePath);
      console.log(`${colors.bold}📁 ${relPath}${colors.reset}`);
    }

    if (failureLimit !== undefined && failed >= failureLimit) {
      for (const { test } of fileTests) {
        skipped++;
        const name = test.meta.name || test.meta.id;
        console.log(
          `  ${colors.yellow}○${colors.reset} ${name} ${colors.dim}(skipped — fail-fast)${colors.reset}`,
        );
      }
      continue;
    }

    const testIds = fileTests.map((ft) => ft.test.meta.id);
    const exportNames: Record<string, string> = {};
    for (const ft of fileTests) {
      exportNames[ft.test.meta.id] = ft.exportName;
    }
    const testMap = new Map(
      fileTests.map((ft) => [ft.test.meta.id, ft]),
    );
    const testFileUrl = pathToFileURL(groupFilePath).toString();

    const batchTimeout = fileTests.reduce((sum, ft) => {
      return sum +
        (normalizePositiveTimeoutMs(ft.test.meta.timeout) ??
          shared.perTestTimeoutMs ?? 30_000);
    }, 0);

    let testId = "";
    let testName = "";
    let testItem: (typeof fileTests)[0]["test"] | null = null;
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
        filePath: groupFilePath,
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

    for await (
      const event of executor.run(
        testFileUrl,
        "",
        {
          vars: envVars,
          secrets,
          ...(Object.keys(sessionState).length > 0 && { session: sessionState }),
        },
        {
          ...toSingleExecutionOptions(shared),
          timeout: batchTimeout,
          testIds,
          exportNames,
          // Pass concurrency to harness when the batch has parallel-marked tests.
          // The harness uses p-queue to run them concurrently within a single process.
          ...(fileTests.some((ft) => ft.test.meta.parallel) && shared.concurrency > 1
            ? { concurrency: shared.concurrency }
            : {}),
        },
      )
    ) {
      switch (event.type) {
        case "start": {
          const entry = testMap.get(event.id);
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
          const traceMsg = `${event.data.method} ${event.data.url} → ${event.data.status} (${event.data.duration}ms)`;
          addLogEntry("trace", traceMsg, event.data);
          traceCollector.push({
            testId,
            method: event.data.method,
            url: event.data.url,
            status: event.data.status,
          });
          const compactTrace = `${colors.dim}${event.data.method}${colors.reset} ${
            compactUrl(event.data.url)
          } ${colors.dim}→${colors.reset} ${
            colorStatus(event.data.status)
          } ${colors.dim}${event.data.duration}ms${colors.reset}`;
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
          const ev = event.data;
          addLogEntry("event", `[${ev.type}]`, ev);
          if (effectiveRun.verbose) {
            const summary = JSON.stringify(ev.data).slice(0, 80);
            console.log(
              `      ${colors.dim}[${ev.type}] ${summary}${colors.reset}`,
            );
          }
          break;
        }

        case "metric": {
          metricCollector.add(event.name, event.value);
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
          // Accumulate session writes from tests for subsequent files
          sessionState[event.key] = event.value;
          // Do NOT fall through to testEvents — internal only
          continue;
      }

      if (testStarted) testEvents.push(event);
    }

    if (!testStarted && errorMsg) {
      // Harness failed before emitting any test start (e.g. module load error)
      console.log(
        `  ${colors.red}✗ ${errorMsg}${colors.reset}`,
      );
      failed++;
    }

    if (testStarted) {
      if (!errorMsg) errorMsg = "Process exited before test completed";
      finalizeTest();
    }
  }

  // ── Session teardown ───────────────────────────────────────────────────
  if (sessionFile) {
    for await (const event of orchestrator.runSessionTeardown(
      sessionFile,
      { vars: envVars, secrets },
      sessionState,
      toSingleExecutionOptions(shared),
    )) {
      if (event.type === "log") {
        console.log(
          `  ${colors.dim}[session] ${event.message}${colors.reset}`,
        );
      } else if (event.type === "status" && event.status === "failed") {
        console.log(
          `  ${colors.yellow}⚠ Session teardown failed${event.error ? `: ${event.error}` : ""}${colors.reset}`,
        );
      }
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
          method: d.method,
          url: d.url,
          ...(d.requestHeaders && Object.keys(d.requestHeaders).length > 0 ? { headers: d.requestHeaders } : {}),
          ...(d.requestBody !== undefined ? { body: d.requestBody } : {}),
        },
        response: {
          status: d.status,
          durationMs: d.duration,
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
