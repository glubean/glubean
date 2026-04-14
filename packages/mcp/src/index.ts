/**
 * Glubean MCP server (stdio).
 *
 * Purpose:
 * - Let AI agents (Cursor, etc.) run verification-as-code locally
 * - Fetch structured failures (assertions/logs/traces) for automatic fixing
 * - Optionally trigger/tail remote runs via Glubean Open Platform APIs
 *
 * IMPORTANT (stdio transport):
 * - Never write to stdout. Use stderr for logs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { basename, dirname, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { LOCAL_RUN_DEFAULTS, TestExecutor, toSingleExecutionOptions } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";
import { createScanner, extractFromSource, scan } from "@glubean/scanner";
import { extractContractCases } from "@glubean/scanner/static";
import type { BundleMetadata, ExportMeta, FileMeta, ScanResult } from "@glubean/scanner";
import { MCP_PACKAGE_VERSION, DEFAULT_GENERATED_BY } from "./version.js";

type Vars = Record<string, string>;
const METADATA_SCHEMA_VERSION = "1";

// ── MCP trace header stripping ──────────────────────────────────────────────

interface McpTraceConfig {
  keepRequestHeaders: string[];
  keepResponseHeaders: string[];
}

const DEFAULT_MCP_TRACE_CONFIG: McpTraceConfig = {
  keepRequestHeaders: ["content-type", "authorization"],
  keepResponseHeaders: ["content-type", "set-cookie", "location"],
};

let _mcpTraceConfig: McpTraceConfig | undefined;

async function loadMcpTraceConfig(projectRoot: string): Promise<McpTraceConfig> {
  if (_mcpTraceConfig) return _mcpTraceConfig;
  try {
    const pkgPath = resolve(projectRoot, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const userConfig = pkg.glubean?.mcp?.trace;
    if (userConfig) {
      _mcpTraceConfig = {
        keepRequestHeaders: userConfig.keepRequestHeaders ?? DEFAULT_MCP_TRACE_CONFIG.keepRequestHeaders,
        keepResponseHeaders: userConfig.keepResponseHeaders ?? DEFAULT_MCP_TRACE_CONFIG.keepResponseHeaders,
      };
    } else {
      _mcpTraceConfig = DEFAULT_MCP_TRACE_CONFIG;
    }
  } catch {
    _mcpTraceConfig = DEFAULT_MCP_TRACE_CONFIG;
  }
  return _mcpTraceConfig;
}

function filterHeaders(
  headers: Record<string, string> | undefined,
  keepList: string[],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const keep = new Set(keepList.map((h) => h.toLowerCase()));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (keep.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function stripTraceHeaders(trace: unknown, config: McpTraceConfig): unknown {
  if (!trace || typeof trace !== "object") return trace;
  const t = trace as Record<string, unknown>;
  return {
    ...t,
    ...(t.requestHeaders !== undefined && {
      requestHeaders: filterHeaders(t.requestHeaders as Record<string, string>, config.keepRequestHeaders),
    }),
    ...(t.responseHeaders !== undefined && {
      responseHeaders: filterHeaders(t.responseHeaders as Record<string, string>, config.keepResponseHeaders),
    }),
  };
}

export async function findProjectRoot(startDir: string): Promise<string> {
  let dir = startDir;
  while (true) {
    try {
      await stat(resolve(dir, "package.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root reached
      dir = parent;
    }
  }
  return startDir;
}

export async function loadEnvFile(envPath: string): Promise<Vars> {
  try {
    const content = await readFile(envPath, "utf-8");
    return parseEnvContent(content);
  } catch {
    return {};
  }
}

/**
 * Simple KEY=VALUE parser for .env files.
 * Handles comments, empty lines, and quoted values.
 */
function parseEnvContent(content: string): Vars {
  const vars: Vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Derive the secrets file path from an env file path.
 * Convention: `.env` → `.env.secrets`, `.env.staging` → `.env.staging.secrets`.
 */
export function deriveSecretsPath(envPath: string): string {
  return resolve(dirname(envPath), `${basename(envPath)}.secrets`);
}

/**
 * Read the active environment from `.glubean/active-env` in the project root.
 * Returns `undefined` if not set.
 */
async function readActiveEnv(projectRoot: string): Promise<string | undefined> {
  try {
    const content = await readFile(resolve(projectRoot, ".glubean", "active-env"), "utf-8");
    const env = content.trim();
    return env || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the env file path, checking `.glubean/active-env` when no explicit envFile is given.
 */
async function resolveEnvPath(projectRoot: string, envFile?: string): Promise<string> {
  if (envFile) return resolve(envFile);
  const activeEnv = await readActiveEnv(projectRoot);
  if (activeEnv) return resolve(projectRoot, `.env.${activeEnv}`);
  return resolve(projectRoot, ".env");
}

function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeFileMap(
  files: Record<string, FileMeta>,
): Record<string, FileMeta> {
  const normalized: Record<string, FileMeta> = {};
  for (const [path, meta] of Object.entries(files)) {
    const normalizedPath = normalizeFilePath(path);
    if (normalized[normalizedPath]) {
      throw new Error(`Duplicate file path after normalization: ${path}`);
    }
    normalized[normalizedPath] = meta;
  }
  return normalized;
}

function deriveMetadataStats(files: Record<string, FileMeta>): {
  testCount: number;
  fileCount: number;
  tags: string[];
} {
  let testCount = 0;
  const allTags = new Set<string>();

  for (const fileMeta of Object.values(files)) {
    for (const exp of fileMeta.exports) {
      if (exp.tags) {
        exp.tags.forEach((tag) => allTags.add(tag));
      }
      testCount += 1;
    }
  }

  return {
    testCount,
    fileCount: Object.keys(files).length,
    tags: Array.from(allTags).sort(),
  };
}

async function computeRootHash(
  files: Record<string, FileMeta>,
): Promise<string> {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const payload = entries
    .map(([path, meta]) => `${path}:${meta.hash}`)
    .join("\n");
  const hash = createHash("sha256").update(payload).digest("hex");
  return `sha256-${hash}`;
}

async function buildMetadata(
  scanResult: ScanResult,
  options: { generatedBy: string; generatedAt?: string },
): Promise<BundleMetadata> {
  const normalizedFiles = normalizeFileMap(scanResult.files);
  const stats = deriveMetadataStats(normalizedFiles);
  const rootHash = await computeRootHash(normalizedFiles);

  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    specVersion: scanResult.specVersion,
    generatedBy: options.generatedBy,
    generatedAt: options.generatedAt || new Date().toISOString(),
    rootHash,
    files: normalizedFiles,
    testCount: stats.testCount,
    fileCount: stats.fileCount,
    tags: stats.tags,
    warnings: scanResult.warnings,
  };
}

// ── Contract discovery ──────────────────────────────────────────────────────

/**
 * Unified test metadata for MCP discovery.
 * Follows CLI's DiscoveredTestMeta pattern — contract cases carry
 * requires/defaultRun/deferred natively instead of being forced into ExportMeta.
 */
interface DiscoveredTest {
  exportName: string;
  id: string;
  name?: string;
  skip?: boolean;
  only?: boolean;
  tags?: string[];
  requires?: string;
  defaultRun?: string;
  deferred?: string;
}

/**
 * Inline skip logic for contract cases (mirrors cli/src/lib/skip.ts).
 * Returns a skip reason string, or undefined if the test should run.
 */
function shouldSkipContractCase(
  meta: { requires?: string; defaultRun?: string; deferred?: string },
): string | undefined {
  if (meta.deferred) return `deferred: ${meta.deferred}`;

  const requires = meta.requires ?? "headless";
  const defaultRun = meta.defaultRun ?? "always";

  // MCP is always headless — no browser or out-of-band capability
  if (requires === "browser") return "requires: browser";
  if (requires === "out-of-band") return "requires: out-of-band";

  // MCP never runs opt-in cases by default
  if (defaultRun === "opt-in" && requires === "headless") return "defaultRun: opt-in";

  return undefined;
}

export async function discoverTestsFromFile(filePath: string): Promise<{
  fileUrl: string;
  tests: DiscoveredTest[];
}> {
  const absolutePath = resolve(filePath);
  const fileUrl = pathToFileURL(absolutePath).toString();
  const content = await readFile(absolutePath, "utf-8");

  // Contract files: use extractContractCases(), same pattern as CLI's discoverTests()
  if (basename(absolutePath).includes(".contract.")) {
    const contracts = extractContractCases(content);
    const tests: DiscoveredTest[] = contracts.flatMap((contract) =>
      contract.cases.map((c) => ({
        exportName: contract.exportName,
        id: `${contract.contractId}.${c.key}`,
        name: `${contract.endpoint} — ${c.key}`,
        skip: !!c.deferred,
        only: false,
        tags: [],
        requires: c.requires,
        defaultRun: c.defaultRun,
        deferred: c.deferred,
      })),
    );
    return { fileUrl, tests };
  }

  // Regular test files: use extractFromSource()
  const metas = extractFromSource(content);
  const tests: DiscoveredTest[] = metas.map((m) => ({
    exportName: m.exportName,
    id: m.id,
    name: m.name,
    skip: m.skip,
    only: m.only,
    tags: m.tags,
  }));
  return { fileUrl, tests };
}

function resolveRootDir(dir?: string): string {
  return dir ? resolve(dir) : process.cwd();
}

async function scanProject(
  dir: string,
  mode: "runtime" | "static",
): Promise<ScanResult> {
  if (mode === "static") {
    const scanner = createScanner();
    return await scanner.scan(dir);
  }
  return await scan(dir);
}

export interface LocalRunResult {
  exportName: string;
  id: string;
  name?: string;
  success: boolean;
  durationMs: number;
  assertions: Array<{
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
  }>;
  logs: Array<{ message: string; data?: unknown }>;
  traces: Array<unknown>;
  error?: { message: string; stack?: string };
}

export interface LocalDebugEvent {
  type: "result" | "assertion" | "log" | "trace";
  testId: string;
  exportName: string;
  testName?: string;
  success?: boolean;
  durationMs?: number;
  message?: string;
  passed?: boolean;
  actual?: unknown;
  expected?: unknown;
  data?: unknown;
  error?: { message: string; stack?: string };
}

export interface LocalRunSnapshot {
  createdAt: string;
  fileUrl: string;
  projectRoot: string;
  summary: { total: number; passed: number; failed: number };
  results: LocalRunResult[];
  includeLogs: boolean;
  includeTraces: boolean;
  filter?: string;
}

export interface ConfigDiagnostics {
  projectRoot: string;
  packageJson: { path: string; exists: boolean };
  envFile: { path: string; exists: boolean; varCount: number; hasBaseUrl: boolean };
  secretsFile: { path: string; exists: boolean; secretCount: number };
  testsDir: { path: string; exists: boolean };
  exploreDir: { path: string; exists: boolean };
  recommendations: string[];
}

let lastLocalRunSnapshot: LocalRunSnapshot | undefined;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function toLocalDebugEvents(
  snapshot: LocalRunSnapshot,
): LocalDebugEvent[] {
  const events: LocalDebugEvent[] = [];
  for (const result of snapshot.results) {
    events.push({
      type: "result",
      testId: result.id,
      exportName: result.exportName,
      testName: result.name,
      success: result.success,
      durationMs: result.durationMs,
      error: result.error,
    });

    for (const assertion of result.assertions) {
      events.push({
        type: "assertion",
        testId: result.id,
        exportName: result.exportName,
        testName: result.name,
        passed: assertion.passed,
        message: assertion.message,
        actual: assertion.actual,
        expected: assertion.expected,
      });
    }

    for (const log of result.logs) {
      events.push({
        type: "log",
        testId: result.id,
        exportName: result.exportName,
        testName: result.name,
        message: log.message,
        data: log.data,
      });
    }

    for (const trace of result.traces) {
      events.push({
        type: "trace",
        testId: result.id,
        exportName: result.exportName,
        testName: result.name,
        data: trace,
      });
    }
  }
  return events;
}

export function filterLocalDebugEvents(
  events: LocalDebugEvent[],
  options: { type?: LocalDebugEvent["type"]; testId?: string; limit?: number },
): LocalDebugEvent[] {
  let filtered = events;
  if (options.type) {
    filtered = filtered.filter((event) => event.type === options.type);
  }
  if (options.testId) {
    filtered = filtered.filter((event) => event.testId === options.testId);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  return filtered.slice(0, limit);
}

export function buildLastRunSummary(
  snapshot: LocalRunSnapshot,
): Record<string, unknown> {
  return {
    createdAt: snapshot.createdAt,
    fileUrl: snapshot.fileUrl,
    projectRoot: snapshot.projectRoot,
    summary: snapshot.summary,
    includeLogs: snapshot.includeLogs,
    includeTraces: snapshot.includeTraces,
    filter: snapshot.filter,
    testIds: snapshot.results.map((r) => r.id),
    eventCounts: {
      result: snapshot.results.length,
      assertion: snapshot.results.reduce((acc, r) => acc + r.assertions.length, 0),
      log: snapshot.results.reduce((acc, r) => acc + r.logs.length, 0),
      trace: snapshot.results.reduce((acc, r) => acc + r.traces.length, 0),
    },
  };
}

export async function diagnoseProjectConfig(args: {
  dir?: string;
  envFile?: string;
}): Promise<ConfigDiagnostics> {
  const rootDir = resolveRootDir(args.dir);
  const projectRoot = await findProjectRoot(rootDir);
  const packageJsonPath = resolve(projectRoot, "package.json");
  const envPath = await resolveEnvPath(projectRoot, args.envFile);
  const secretsPath = deriveSecretsPath(envPath);

  const [packageJsonExists, envExists, secretsExists, testsDirExists, exploreDirExists] = await Promise.all([
    pathExists(packageJsonPath),
    pathExists(envPath),
    pathExists(secretsPath),
    pathExists(resolve(projectRoot, "tests")),
    pathExists(resolve(projectRoot, "explore")),
  ]);

  const envVars = envExists ? await loadEnvFile(envPath) : {};
  const secrets = secretsExists ? await loadEnvFile(secretsPath) : {};

  const recommendations: string[] = [];
  if (!packageJsonExists) {
    recommendations.push('Missing "package.json" at project root.');
  }
  if (!envExists) {
    recommendations.push('Missing ".env" file (expected BASE_URL).');
  } else if (!("BASE_URL" in envVars)) {
    recommendations.push('Add BASE_URL to ".env" for HTTP tests.');
  }
  if (!secretsExists) {
    recommendations.push('Missing ".env.secrets" file. Add it when tests require secrets.');
  }
  if (!testsDirExists && !exploreDirExists) {
    recommendations.push('Create "tests/" or "explore/" to add runnable test files.');
  }

  return {
    projectRoot,
    packageJson: { path: packageJsonPath, exists: packageJsonExists },
    envFile: {
      path: envPath,
      exists: envExists,
      varCount: Object.keys(envVars).length,
      hasBaseUrl: "BASE_URL" in envVars,
    },
    secretsFile: {
      path: secretsPath,
      exists: secretsExists,
      secretCount: Object.keys(secrets).length,
    },
    testsDir: {
      path: resolve(projectRoot, "tests"),
      exists: testsDirExists,
    },
    exploreDir: {
      path: resolve(projectRoot, "explore"),
      exists: exploreDirExists,
    },
    recommendations,
  };
}

export async function runLocalTestsFromFile(args: {
  filePath: string;
  filter?: string;
  envFile?: string;
  includeLogs?: boolean;
  includeTraces?: boolean;
  stopOnFailure?: boolean;
  concurrency?: number;
}): Promise<{
  fileUrl: string;
  projectRoot: string;
  vars: Vars;
  secrets: Vars;
  results: LocalRunResult[];
  summary: { total: number; passed: number; failed: number };
  error?: string;
}> {
  const absolutePath = resolve(args.filePath);
  const testDir = dirname(absolutePath);
  const projectRoot = await findProjectRoot(testDir);
  const traceConfig = await loadMcpTraceConfig(projectRoot);

  const envPath = await resolveEnvPath(projectRoot, args.envFile);
  const secretsPath = deriveSecretsPath(envPath);

  const [vars, secrets] = await Promise.all([
    loadEnvFile(envPath),
    loadEnvFile(secretsPath),
  ]);

  const { fileUrl, tests } = await discoverTestsFromFile(absolutePath);

  const hasOnly = tests.some((t) => t.only);
  const normalizedFilter = args.filter?.toLowerCase().trim();

  const selected = tests.filter((t) => {
    if (t.skip) return false;
    if (hasOnly && !t.only) return false;
    // Contract cases: check requires/defaultRun/deferred
    if (t.requires || t.defaultRun || t.deferred) {
      if (shouldSkipContractCase(t)) return false;
    }
    if (!normalizedFilter) return true;
    const haystack = [t.id, t.name ?? "", ...(t.tags ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedFilter);
  });

  if (selected.length === 0) {
    return {
      fileUrl,
      projectRoot,
      vars,
      secrets,
      results: [],
      summary: { total: 0, passed: 0, failed: 0 },
      error: tests.length === 0
        ? "No tests discovered in file. Check that exports use test() or contract.http() from @glubean/sdk."
        : `No tests matched filter "${args.filter}". Available: ${tests.map((t) => t.id).join(", ")}`,
    };
  }

  const includeLogs = args.includeLogs ?? true;
  const includeTraces = args.includeTraces ?? false;

  const shared: SharedRunConfig = {
    ...LOCAL_RUN_DEFAULTS,
    failFast: Boolean(args.stopOnFailure),
    concurrency: Math.max(1, args.concurrency ?? 1),
    // When AI requests traces, auto-enable full trace + schema + truncation
    ...(includeTraces && {
      emitFullTrace: true,
      inferSchema: true,
      truncateArrays: true,
    }),
  };
  const executor = TestExecutor.fromSharedConfig(shared, {
    cwd: projectRoot,
  }).withSession(projectRoot);

  const concurrency = shared.concurrency;
  const stopOnFailure = shared.failFast;

  const results: LocalRunResult[] = [];
  let nextIndex = 0;
  let stop = false;

  const runNext = async (): Promise<void> => {
    while (!stop) {
      const index = nextIndex++;
      if (index >= selected.length) return;

      const test = selected[index];
      const start = Date.now();

      const logs: LocalRunResult["logs"] = [];
      const assertions: LocalRunResult["assertions"] = [];
      const traces: LocalRunResult["traces"] = [];

      let statusSuccess = false;
      let errorMessage: string | undefined;
      let errorStack: string | undefined;

      for await (
        const event of executor.run(fileUrl, test.id, {
          vars,
          secrets,
        }, { ...toSingleExecutionOptions(shared), exportName: test.exportName })
      ) {
        switch (event.type) {
          case "log":
            if (includeLogs) {
              logs.push({ message: event.message, data: event.data });
            }
            break;
          case "assertion":
            assertions.push({
              passed: event.passed,
              message: event.message,
              actual: event.actual,
              expected: event.expected,
            });
            break;
          case "trace":
            if (includeTraces) traces.push(stripTraceHeaders(event.data, traceConfig));
            break;
          case "status":
            statusSuccess = event.status === "completed";
            if (event.error) errorMessage = event.error;
            if (event.stack) errorStack = event.stack;
            break;
          case "error":
            errorMessage = event.message;
            break;
        }
      }

      const allAssertionsPassed = assertions.every((a) => a.passed);
      const success = statusSuccess && allAssertionsPassed && !errorMessage;

      const result: LocalRunResult = {
        exportName: test.exportName,
        id: test.id,
        name: test.name,
        success,
        durationMs: Date.now() - start,
        assertions,
        logs,
        traces,
        error: errorMessage ? { message: errorMessage, stack: errorStack } : undefined,
      };
      results.push(result);

      if (!success && stopOnFailure) {
        stop = true;
        return;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, selected.length || 1) },
    () => runNext(),
  );
  await Promise.all(workers);

  // Session teardown (no-op if no session.ts was discovered)
  for await (const _event of executor.finalize()) {}

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    fileUrl,
    projectRoot,
    vars,
    secrets,
    results,
    summary: { total: results.length, passed, failed },
  };
}

function bearerHeaders(token?: string): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = new McpServer({
  name: "glubean",
  version: MCP_PACKAGE_VERSION,
});

export const MCP_TOOL_NAMES = {
  discoverTests: "glubean_discover_tests",
  runLocalFile: "glubean_run_local_file",
  getLastRunSummary: "glubean_get_last_run_summary",
  getLocalEvents: "glubean_get_local_events",
  listTestFiles: "glubean_list_test_files",
  projectContracts: "glubean_project_contracts",
  extractContracts: "glubean_extract_contracts",
  openapi: "glubean_openapi",
  diagnoseConfig: "glubean_diagnose_config",
  getMetadata: "glubean_get_metadata",
  openTriggerRun: "glubean_open_trigger_run",
  openGetRun: "glubean_open_get_run",
  openGetRunEvents: "glubean_open_get_run_events",
} as const;

server.registerTool(
  MCP_TOOL_NAMES.discoverTests,
  {
    description: "Discover Glubean test exports from a file path and return their metadata.",
    inputSchema: {
      filePath: z
        .string()
        .describe("Path to a test module file (e.g. tests/api.test.ts)"),
    },
  },
  async (input: { filePath: string }) => {
    const { filePath } = input;
    const { tests } = await discoverTestsFromFile(filePath);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ tests }),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.runLocalFile,
  {
    description: "Run Glubean test exports from a file locally and return structured results for AI debugging/fixing. When includeTraces is true, each trace includes responseSchema (inferred JSON Schema) and truncated responseBody — use responseSchema to understand response structure without reading full data.",
    inputSchema: {
      filePath: z.string().describe("Path to a test module file"),
      filter: z
        .string()
        .optional()
        .describe("Filter by id/name/tag (substring match)"),
      envFile: z
        .string()
        .optional()
        .describe("Path to .env file (default: <projectRoot>/.env)"),
      includeLogs: z
        .boolean()
        .optional()
        .describe("Include ctx.log events (default: true)"),
      includeTraces: z
        .boolean()
        .optional()
        .describe("Include HTTP traces with responseSchema (inferred JSON Schema) and truncated responseBody. Use this to understand API response structure. Default: false."),
      stopOnFailure: z
        .boolean()
        .optional()
        .describe("Stop after first failed test (default: false)"),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .describe("Parallelism (default: 1)"),
    },
  },
  async (input: {
    filePath: string;
    filter?: string;
    envFile?: string;
    includeLogs?: boolean;
    includeTraces?: boolean;
    stopOnFailure?: boolean;
    concurrency?: number;
  }) => {
    const result = await runLocalTestsFromFile({
      filePath: input.filePath,
      filter: input.filter,
      envFile: input.envFile,
      includeLogs: input.includeLogs,
      includeTraces: input.includeTraces,
      stopOnFailure: input.stopOnFailure,
      concurrency: input.concurrency,
    });

    const safe: Record<string, unknown> = {
      projectRoot: result.projectRoot,
      fileUrl: result.fileUrl,
      varsCount: Object.keys(result.vars).length,
      secretsCount: Object.keys(result.secrets).length,
      summary: result.summary,
      results: result.results,
    };
    if (result.error) {
      safe.error = result.error;
    }

    lastLocalRunSnapshot = {
      createdAt: new Date().toISOString(),
      fileUrl: result.fileUrl,
      projectRoot: result.projectRoot,
      summary: result.summary,
      results: result.results,
      includeLogs: input.includeLogs ?? true,
      includeTraces: input.includeTraces ?? false,
      filter: input.filter,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(safe) }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.getLastRunSummary,
  {
    description: "Return summary of the most recent glubean_run_local_file execution.",
    inputSchema: {},
  },
  () => {
    if (!lastLocalRunSnapshot) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            { error: "No local run snapshot available. Run glubean_run_local_file first." },
            null,
            2,
          ),
        }],
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(buildLastRunSummary(lastLocalRunSnapshot)),
      }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.getLocalEvents,
  {
    description: "Return filtered local events from the most recent glubean_run_local_file execution.",
    inputSchema: {
      type: z
        .enum(["result", "assertion", "log", "trace"])
        .optional()
        .describe("Filter by local event type"),
      testId: z
        .string()
        .optional()
        .describe("Filter by discovered test id"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum events returned (default: 200)"),
    },
  },
  (input: {
    type?: LocalDebugEvent["type"];
    testId?: string;
    limit?: number;
  }) => {
    if (!lastLocalRunSnapshot) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            { error: "No local run snapshot available. Run glubean_run_local_file first." },
            null,
            2,
          ),
        }],
      };
    }

    const events = toLocalDebugEvents(lastLocalRunSnapshot);
    const filtered = filterLocalDebugEvents(events, {
      type: input.type,
      testId: input.testId,
      limit: input.limit,
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          {
            availableTotal: events.length,
            returned: filtered.length,
            filters: {
              type: input.type,
              testId: input.testId,
              limit: input.limit ?? 200,
            },
            events: filtered,
          },
          null,
          2,
        ),
      }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.listTestFiles,
  {
    description: "List Glubean test files in a directory (lightweight index, no file writes).",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe(
          "Project root directory (default: current working directory)",
        ),
      mode: z
        .enum(["static", "runtime"])
        .optional()
        .describe(
          'Scan mode: "static" (no runtime imports, default) or "runtime" (most accurate)',
        ),
    },
  },
  async (input: { dir?: string; mode?: "static" | "runtime" }) => {
    const rootDir = resolveRootDir(input.dir);
    const mode = input.mode ?? "static";
    const result = await scanProject(rootDir, mode);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              rootDir,
              mode,
              fileCount: result.fileCount,
              files: Object.keys(result.files).sort(),
              warnings: result.warnings,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.projectContracts,
  {
    description:
      "Return all contract specs in the project as structured JSON, grouped by feature. " +
      "Each contract includes endpoint, description, feature, and cases with descriptions. " +
      "Use this to understand the API specification, generate documentation, or review contract coverage.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Project root directory (default: current working directory)"),
    },
  },
  async (input: { dir?: string }) => {
    const rootDir = resolveRootDir(input.dir);
    const result = await scanProject(rootDir, "static");
    const contracts = result.contracts ?? [];

    if (contracts.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "No contracts found. Ensure .contract.ts files exist and export contract.http().",
            }),
          },
        ],
      };
    }

    // Group by feature
    const featureMap = new Map<string, typeof contracts>();
    for (const c of contracts) {
      const key = c.feature ?? c.endpoint;
      if (!featureMap.has(key)) featureMap.set(key, []);
      featureMap.get(key)!.push(c);
    }

    let totalCases = 0;
    let deferred = 0;
    let gated = 0;
    for (const c of contracts) {
      for (const cas of c.cases) {
        totalCases++;
        if (cas.deferred) deferred++;
        else if (cas.requires === "browser" || cas.requires === "out-of-band") gated++;
      }
    }

    const output = {
      features: Array.from(featureMap.entries()).map(([name, group]) => ({
        name,
        contracts: group.map((c) => ({
          id: c.contractId,
          endpoint: c.endpoint,
          description: c.description,
          feature: c.feature,
          cases: c.cases.map((cas) => ({
            key: cas.key,
            description: cas.description,
            status: cas.expectStatus,
            deferred: cas.deferred,
            requires: cas.requires,
            defaultRun: cas.defaultRun,
          })),
        })),
      })),
      summary: {
        total: totalCases,
        active: totalCases - deferred - gated,
        deferred,
        gated,
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.diagnoseConfig,
  {
    description: "Diagnose local project config (.env, .env.secrets, package.json, tests/explore dirs).",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Project root directory (default: current working directory)"),
      envFile: z
        .string()
        .optional()
        .describe("Path to .env file (default: <projectRoot>/.env)"),
    },
  },
  async (input: { dir?: string; envFile?: string }) => {
    const diagnostics = await diagnoseProjectConfig(input);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(diagnostics),
      }],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.getMetadata,
  {
    description: "Generate metadata (equivalent to metadata.json) in-memory for AI use, without writing to disk.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe(
          "Project root directory (default: current working directory)",
        ),
      mode: z
        .enum(["runtime", "static"])
        .optional()
        .describe(
          'Scan mode: "runtime" (most accurate, default) or "static" (no runtime imports)',
        ),
      generatedBy: z
        .string()
        .optional()
        .describe(
          `Override generatedBy field (default: "${DEFAULT_GENERATED_BY}")`,
        ),
    },
  },
  async (input: {
    dir?: string;
    mode?: "runtime" | "static";
    generatedBy?: string;
  }) => {
    const rootDir = resolveRootDir(input.dir);
    const mode = input.mode ?? "runtime";
    const result = await scanProject(rootDir, mode);
    const metadata = await buildMetadata(result, {
      generatedBy: input.generatedBy ?? DEFAULT_GENERATED_BY,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              rootDir,
              mode,
              metadata,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openTriggerRun,
  {
    description: "Trigger a remote run via Glubean Open Platform API (POST /open/v1/runs).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:write scope"),
      projectId: z.string().describe("Project ID (short id)"),
      bundleId: z.string().describe("Bundle ID (short id)"),
      jobId: z.string().optional().describe("Optional job ID"),
    },
  },
  async (input: {
    apiUrl: string;
    token: string;
    projectId: string;
    bundleId: string;
    jobId?: string;
  }) => {
    const { apiUrl, token, projectId, bundleId, jobId } = input;
    const url = `${apiUrl.replace(/\/$/, "")}/open/v1/runs`;
    const body = { projectId, bundleId, jobId };
    const json = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearerHeaders(token) },
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(json) }] };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openGetRun,
  {
    description: "Get run status via Glubean Open Platform API (GET /open/v1/runs/:runId).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:read scope"),
      runId: z.string().describe("Run ID"),
    },
  },
  async (input: { apiUrl: string; token: string; runId: string }) => {
    const { apiUrl, token, runId } = input;
    const url = `${apiUrl.replace(/\/$/, "")}/open/v1/runs/${encodeURIComponent(runId)}`;
    const json = await fetchJson(url, {
      method: "GET",
      headers: bearerHeaders(token),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(json) }] };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openGetRunEvents,
  {
    description: "Fetch a page of run events via Glubean Open Platform API (GET /open/v1/runs/:runId/events).",
    inputSchema: {
      apiUrl: z.string().describe("Base API URL, e.g. https://api.glubean.com"),
      token: z.string().describe("Project token with runs:read scope"),
      runId: z.string().describe("Run ID"),
      afterSeq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Cursor: return events after this seq"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max events (default server: 100)"),
      type: z
        .string()
        .optional()
        .describe("Filter by event type (log/assert/trace/result)"),
    },
  },
  async (input: {
    apiUrl: string;
    token: string;
    runId: string;
    afterSeq?: number;
    limit?: number;
    type?: string;
  }) => {
    const { apiUrl, token, runId, afterSeq, limit, type } = input;
    const base = `${apiUrl.replace(/\/$/, "")}/open/v1/runs/${encodeURIComponent(runId)}/events`;
    const params = new URLSearchParams();
    if (afterSeq !== undefined) params.set("afterSeq", String(afterSeq));
    if (limit !== undefined) params.set("limit", String(limit));
    if (type) params.set("type", type);
    const qs = params.toString();
    const url = qs ? `${base}?${qs}` : base;

    const json = await fetchJson(url, {
      method: "GET",
      headers: bearerHeaders(token),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(json) }] };
  },
);

// =============================================================================
// Runtime contract extraction — dynamic import to access Zod schemas
// =============================================================================

/**
 * Check if a value looks like an HttpContract (duck-typing).
 */
function isHttpContract(val: unknown): val is {
  id: string;
  endpoint: string;
  description?: string;
  feature?: string;
  request?: { safeParse: Function };
  _caseSchemas?: Record<string, {
    expectStatus?: number;
    responseSchema?: { safeParse: Function };
    description?: string;
  }>;
  length: number;
} {
  return (
    Array.isArray(val) &&
    typeof (val as any).id === "string" &&
    typeof (val as any).endpoint === "string"
  );
}

/**
 * Try to convert a SchemaLike to JSON Schema using Zod v4's toJSONSchema.
 * Returns null if the schema is not a Zod type or conversion fails.
 */
async function schemaToJsonSchema(schema: unknown): Promise<unknown | null> {
  if (!schema || typeof schema !== "object") return null;
  try {
    // Use the schema's own toJSONSchema() instance method (Zod v4).
    // This avoids cross-instance issues when the MCP server's zod
    // is a different copy than the contract module's zod.
    if (typeof (schema as any).toJSONSchema === "function") {
      return (schema as any).toJSONSchema();
    }
  } catch (err) {
    // Log conversion failures to stderr (won't pollute MCP stdout)
    console.error(`[glubean:mcp] toJSONSchema failed: ${err instanceof Error ? err.message : err}`);
  }
  return null;
}

/**
 * Extract full contract data from a project by dynamically importing modules.
 */
async function extractContractsRuntime(rootDir: string): Promise<Array<{
  id: string;
  endpoint: string;
  description?: string;
  feature?: string;
  requestSchema: unknown | null;
  cases: Array<{
    key: string;
    description?: string;
    expectStatus?: number;
    responseSchema: unknown | null;
  }>;
}>> {
  // Use static scanner to find .contract.ts files
  const result = await scanProject(rootDir, "static");
  const staticContracts = result.contracts ?? [];
  if (staticContracts.length === 0) return [];

  // Collect file paths from scan result
  const contractFiles = new Set<string>();
  if (result.files) {
    for (const [filePath, _meta] of Object.entries(result.files)) {
      if (filePath.includes(".contract.")) {
        contractFiles.add(resolve(rootDir, filePath));
      }
    }
  }
  // Fallback: scan for .contract.ts files using the static metadata
  if (contractFiles.size === 0) {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.includes(".contract.")) contractFiles.add(full);
      }
    };
    walk(rootDir);
  }

  const contracts: Awaited<ReturnType<typeof extractContractsRuntime>> = [];

  for (const filePath of contractFiles) {
    try {
      const mod = await import(pathToFileURL(filePath).href);
      for (const [, value] of Object.entries(mod)) {
        if (!isHttpContract(value)) continue;

        const requestSchema = await schemaToJsonSchema(value.request);
        const cases: typeof contracts[0]["cases"] = [];

        if (value._caseSchemas) {
          for (const [key, caseMeta] of Object.entries(value._caseSchemas)) {
            cases.push({
              key,
              description: caseMeta.description,
              expectStatus: caseMeta.expectStatus,
              responseSchema: await schemaToJsonSchema(caseMeta.responseSchema),
            });
          }
        }

        contracts.push({
          id: value.id,
          endpoint: value.endpoint,
          description: value.description,
          feature: value.feature,
          requestSchema,
          cases,
        });
      }
    } catch (err) {
      console.error(`[glubean:mcp] Failed to import ${filePath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return contracts;
}

server.registerTool(
  MCP_TOOL_NAMES.extractContracts,
  {
    description:
      "Extract full contract metadata by dynamically importing .contract.ts modules. " +
      "Unlike glubean_project_contracts (static-only), this tool accesses runtime values " +
      "including Zod schemas converted to JSON Schema. Use this for OpenAPI generation " +
      "or detailed schema analysis.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Project root directory (default: current working directory)"),
    },
  },
  async (input: { dir?: string }) => {
    const rootDir = resolveRootDir(input.dir);
    const contracts = await extractContractsRuntime(rootDir);

    if (contracts.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "No contracts found. Ensure .contract.ts files exist and export contract.http().",
          }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ contracts }, null, 2),
      }],
    };
  },
);

// =============================================================================
// OpenAPI spec generation from runtime contract data
// =============================================================================

function contractsToOpenApi(
  contracts: Awaited<ReturnType<typeof extractContractsRuntime>>,
  title = "API Specification",
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  for (const c of contracts) {
    // Parse "METHOD /path" → { method, path }
    const match = c.endpoint.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
    if (!match) continue;
    const method = match[1].toLowerCase();
    let apiPath = match[2];

    // Convert :param to {param} for OpenAPI
    apiPath = apiPath.replace(/:(\w+)/g, "{$1}");

    if (!paths[apiPath]) paths[apiPath] = {};
    if (c.feature) tags.add(c.feature);

    // Build responses from cases
    const responses: Record<string, unknown> = {};
    for (const cas of c.cases) {
      const statusCode = String(cas.expectStatus ?? 200);
      if (!responses[statusCode]) {
        const resp: Record<string, unknown> = {
          description: cas.description ?? "",
        };
        if (cas.responseSchema) {
          resp.content = {
            "application/json": { schema: cas.responseSchema },
          };
        }
        responses[statusCode] = resp;
      }
    }

    // Build operation
    const operation: Record<string, unknown> = {
      operationId: c.id,
      summary: c.description,
      responses,
    };
    if (c.feature) operation.tags = [c.feature];

    // Extract path parameters
    const paramMatches = apiPath.matchAll(/\{(\w+)\}/g);
    const params = [...paramMatches].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (params.length > 0) operation.parameters = params;

    // Request body
    if (c.requestSchema) {
      operation.requestBody = {
        content: {
          "application/json": { schema: c.requestSchema },
        },
      };
    }

    paths[apiPath][method] = operation;
  }

  return {
    openapi: "3.1.0",
    info: { title, version: "1.0.0" },
    ...(tags.size > 0 ? { tags: [...tags].map((t) => ({ name: t })) } : {}),
    paths,
  };
}

server.registerTool(
  MCP_TOOL_NAMES.openapi,
  {
    description:
      "Generate an OpenAPI 3.1 specification from contract.http() definitions. " +
      "Dynamically imports contract modules to extract Zod schemas and converts them " +
      "to JSON Schema. Returns a complete OpenAPI spec as JSON.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Project root directory (default: current working directory)"),
      title: z
        .string()
        .optional()
        .describe("API title for the OpenAPI info section (default: 'API Specification')"),
    },
  },
  async (input: { dir?: string; title?: string }) => {
    const rootDir = resolveRootDir(input.dir);
    const contracts = await extractContractsRuntime(rootDir);

    if (contracts.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "No contracts found. Ensure .contract.ts files exist and export contract.http().",
          }),
        }],
      };
    }

    const spec = contractsToOpenApi(contracts, input.title);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(spec, null, 2),
      }],
    };
  },
);

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("glubean MCP server running (stdio)");
}

// Auto-start when run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("/mcp.js") ||
  process.argv[1].endsWith("/index.js") ||
  process.argv[1].includes("@glubean/mcp") ||
  process.argv[1].endsWith("/glubean-mcp")
);
if (isMain) {
  main();
}
