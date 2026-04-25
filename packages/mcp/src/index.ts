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

import { applyEnvTemplating, bootstrap, loadProjectEnv, LOCAL_RUN_DEFAULTS, ProjectRunner, TestExecutor, toSingleExecutionOptions } from "@glubean/runner";
import type { ProjectRunnerTest } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";
import { renderArtifact, openapiArtifact } from "@glubean/sdk";
import type { ExtractedContractProjection } from "@glubean/sdk";
import { createScanner, extractFromSource, scan } from "@glubean/scanner";
import { extractContractCases } from "@glubean/scanner/static";
import {
  extractContractFromFile as sharedExtractFromFile,
  extractContractsFromProject as sharedExtractFromProject,
  type NormalizedContractMeta as SharedExtractedContract,
} from "@glubean/scanner";
import type { BundleMetadata, ExportMeta, FileMeta, ScanResult } from "@glubean/scanner";
import { MCP_PACKAGE_VERSION, DEFAULT_GENERATED_BY } from "./version.js";

type Vars = Record<string, string>;
const METADATA_SCHEMA_VERSION = "1";

// ── HTTP-shaped legacy view over new NormalizedContractMeta ─────────────────
//
// After the v0.2 contract rewrite, scanner emits adapter-agnostic output with
// schemas as an opaque blob. MCP's OpenAPI generation + project-contracts
// consolidation were written against the pre-rewrite flat HTTP shape. Rather
// than rewriting those ~300 lines inline, we produce a "legacy HTTP view"
// that flattens the HTTP schemas back out onto the contract/case objects.
//
// For non-HTTP protocols the legacy fields will be undefined. OpenAPI
// generation naturally skips contracts where it can't find HTTP info.
//
// This helper will be removed in a follow-up that migrates full OpenAPI
// generation into `@glubean/sdk`'s `sdk/src/contract-http/openapi.ts`.

interface LegacyHttpCase {
  key: string;
  description?: string;
  lifecycle: string;
  severity: string;
  deferredReason?: string;
  deprecatedReason?: string;
  requires?: string;
  defaultRun?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
  // HTTP-flattened fields (undefined for non-HTTP protocols):
  protocolExpect?: { status?: number };
  responseSchema?: unknown;
  responseContentType?: string;
  responseHeaders?: unknown;
  examples?: Record<string, { value: unknown; summary?: string; description?: string }>;
  paramSchemas?: Record<string, { schema?: unknown; description?: string; required?: boolean; deprecated?: boolean }>;
  querySchemas?: Record<string, { schema?: unknown; description?: string; required?: boolean; deprecated?: boolean }>;
}

interface LegacyHttpContract {
  id: string;
  exportName: string;
  protocol: string;
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  tags?: string[];
  deprecated?: string;
  extensions?: Record<string, unknown>;
  security?: unknown;
  requestSchema?: unknown;
  requestContentType?: string;
  requestHeaders?: unknown;
  requestExample?: unknown;
  requestExamples?: Record<string, { value: unknown; summary?: string; description?: string }>;
  cases: LegacyHttpCase[];
}

function toLegacyHttpContract(c: SharedExtractedContract): LegacyHttpContract {
  // Support BOTH shapes during transitional P4:
  //   - new (v0.2 scanner output): fields nested under `schemas.request` /
  //     `case.schemas.response` etc.
  //   - old (pre-v0.2 test fixtures cast `as any`): fields flat on the
  //     contract / case objects. Regression tests for OpenAPI generation
  //     still use the old shape inline. Maintaining backward read here
  //     avoids rewriting those tests in the same phase.
  const cAny = c as any;
  const schemas = cAny.schemas as
    | {
        request?: {
          body?: unknown;
          contentType?: string;
          headers?: unknown;
          example?: unknown;
          examples?: Record<string, { value: unknown; summary?: string; description?: string }>;
        };
        security?: unknown;
      }
    | undefined;

  return {
    id: c.id,
    exportName: c.exportName,
    protocol: c.protocol,
    target: c.target,
    description: c.description,
    feature: c.feature,
    instanceName: c.instanceName,
    tags: c.tags,
    deprecated: c.deprecated,
    extensions: c.extensions,
    security: schemas?.security ?? cAny.security,
    requestSchema: schemas?.request?.body ?? cAny.requestSchema,
    requestContentType: schemas?.request?.contentType ?? cAny.requestContentType,
    requestHeaders: schemas?.request?.headers ?? cAny.requestHeaders,
    requestExample: schemas?.request?.example ?? cAny.requestExample,
    requestExamples: schemas?.request?.examples ?? cAny.requestExamples,
    cases: c.cases.map((cs): LegacyHttpCase => {
      const csAny = cs as any;
      const cs_schemas = csAny.schemas as
        | {
            response?: {
              status?: number;
              body?: unknown;
              contentType?: string;
              headers?: unknown;
              example?: unknown;
              examples?: Record<
                string,
                { value: unknown; summary?: string; description?: string }
              >;
            };
            params?: Record<
              string,
              {
                schema?: unknown;
                description?: string;
                required?: boolean;
                deprecated?: boolean;
              }
            >;
            query?: Record<
              string,
              {
                schema?: unknown;
                description?: string;
                required?: boolean;
                deprecated?: boolean;
              }
            >;
          }
        | undefined;
      const response = cs_schemas?.response;
      return {
        key: cs.key,
        description: cs.description,
        lifecycle: cs.lifecycle,
        severity: cs.severity,
        deferredReason: cs.deferredReason,
        deprecatedReason: cs.deprecatedReason,
        requires: cs.requires,
        defaultRun: cs.defaultRun,
        tags: cs.tags,
        extensions: cs.extensions,
        protocolExpect:
          response?.status != null
            ? { status: response.status }
            : csAny.protocolExpect,
        responseSchema: response?.body ?? csAny.responseSchema,
        responseContentType: response?.contentType ?? csAny.responseContentType,
        responseHeaders: response?.headers ?? csAny.responseHeaders,
        examples: response?.examples ?? csAny.examples,
        paramSchemas: cs_schemas?.params ?? csAny.paramSchemas,
        querySchemas: cs_schemas?.query ?? csAny.querySchemas,
      };
    }),
  };
}

function toLegacyHttpContracts(
  contracts: SharedExtractedContract[],
): LegacyHttpContract[] {
  return contracts.map(toLegacyHttpContract);
}

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

// Env loading lives in @glubean/runner as the canonical single source of
// truth (handles dotenv parsing, `${NAME}` expansion, and vars/secrets
// split). Use `loadProjectEnv(rootDir, envFileName)` below.

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
  errors?: Array<{ file: string; error: string }>;
}> {
  const absolutePath = resolve(filePath);
  const fileUrl = pathToFileURL(absolutePath).toString();
  const content = await readFile(absolutePath, "utf-8");

  // Contract files: use shared scanner extraction, fall back to static regex
  if (basename(absolutePath).includes(".contract.")) {
    let tests: DiscoveredTest[] = [];

    const result = await sharedExtractFromFile(absolutePath);
    if (result.contracts.length > 0) {
      tests = result.contracts.flatMap((c) =>
        c.cases.map((cas) => ({
          exportName: c.exportName,
          id: `${c.id}.${cas.key}`,
          name: `${c.target} — ${cas.key}`,
          skip: cas.lifecycle !== "active",
          only: false,
          tags: [],
          requires: cas.requires,
          defaultRun: cas.defaultRun,
          deferred: cas.deferredReason,
        })),
      );
    } else if (result.errors.length > 0) {
      // Runtime import failed — try static regex fallback only for HTTP-only files.
      // If the file contains ANY non-HTTP protocol usage, fail closed for the
      // entire file — partial fallback would silently drop protocol contracts.
      const hasHttp = /contract\.http\b/i.test(content);
      // Detect any contract.<protocol> that isn't contract.http or contract.flow
      const hasNonHttp = /contract\.(?!http\b|flow\b)\w+\s*[.(]/i.test(content);
      const contracts = (hasHttp && !hasNonHttp) ? extractContractCases(content) : [];
      if (contracts.length > 0) {
        tests = contracts.flatMap((contract) =>
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
      } else {
        // Neither runtime nor static found contracts — return structured errors
        return { fileUrl, tests: [], errors: result.errors };
      }
    }

    return { fileUrl, tests, ...(result.errors.length > 0 ? { errors: result.errors } : {}) };
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

  // loadProjectEnv handles missing-file-silent + `${NAME}` expansion +
  // vars/secrets split. Existence flags above are kept for diagnostic reporting.
  const { vars: envVars, secrets } = await loadProjectEnv(projectRoot, basename(envPath));

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
  /**
   * Spike 3 runner input channels (attachment-model §8). Mirrors CLI
   * `--input-json` / `--bootstrap-json` / `--force-standalone`.
   *
   * `inputJson` — explicit case input. When provided, `filter` must
   * resolve to exactly one testId; the input is validated against the
   * case's `needs` schema and runs raw (overlay skipped).
   *
   * `bootstrapInput` — bootstrap params. When provided, `filter` must
   * resolve to exactly one testId; the value is validated against the
   * overlay's `params` schema and passed to overlay's `run()`.
   *
   * `forceStandalone` — debug bypass for `runnability.requireAttachment`
   * on no-needs cases (§6.3 escape valve).
   */
  inputJson?: unknown;
  bootstrapInput?: unknown;
  forceStandalone?: boolean;
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
  const { vars, secrets } = await loadProjectEnv(projectRoot, basename(envPath));

  const { fileUrl, tests, errors: discoveryErrors } = await discoverTestsFromFile(absolutePath);

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
        ? "No tests discovered in file. Check that exports use test() or contract.http.with() from @glubean/sdk."
        : `No tests matched filter "${args.filter}". Available: ${tests.map((t) => t.id).join(", ")}`,
      ...(discoveryErrors && discoveryErrors.length > 0 ? { importErrors: discoveryErrors } : {}),
    };
  }

  const includeLogs = args.includeLogs ?? true;
  const includeTraces = args.includeTraces ?? false;

  const shared: SharedRunConfig = {
    ...LOCAL_RUN_DEFAULTS,
    failFast: Boolean(args.stopOnFailure),
    concurrency: Math.max(1, args.concurrency ?? 1),
    // When AI requests traces, auto-enable full trace + schema + truncation.
    ...(includeTraces && {
      emitFullTrace: true,
      inferSchema: true,
      truncateArrays: true,
    }),
  };

  // Prepare facade input: per-test descriptors the runner will batch into
  // one tsx subprocess (per-file batched — one subprocess for this whole file).
  const facadeTests: ProjectRunnerTest[] = selected.map((t) => ({
    filePath: absolutePath,
    exportName: t.exportName,
    meta: {
      id: t.id,
      name: t.name,
      tags: t.tags,
      only: t.only,
      skip: t.skip,
    } as ProjectRunnerTest["meta"],
  }));

  // ── Spike 3 runner input channels (attachment-model §8) ─────────────────
  // ProjectRunner spawns a tsx subprocess inheriting parent env; the harness
  // reads `GLUBEAN_RUNNER_*` env vars and populates the SDK's runner-input
  // channel. Mirrors CLI run.ts. Restored in finally so concurrent MCP
  // tool calls don't leak state.
  const hasInputChannel =
    args.inputJson !== undefined ||
    args.bootstrapInput !== undefined ||
    args.forceStandalone === true;
  let savedExplicitMap: string | undefined;
  let savedBootstrapMap: string | undefined;
  let savedForceIds: string | undefined;
  if (hasInputChannel) {
    // §5.1 invariant: explicit input always wins; overlay never invoked.
    // Two channels are mutually exclusive — surface boundary enforces it
    // so the dispatcher never silently drops the bootstrap-params side.
    if (args.inputJson !== undefined && args.bootstrapInput !== undefined) {
      return {
        fileUrl,
        projectRoot,
        vars,
        secrets,
        results: [],
        summary: { total: 0, passed: 0, failed: 0 },
        error:
          "inputJson and bootstrapInput are mutually exclusive. " +
          "Per attachment-model §5.1: explicit input bypasses the overlay, so bootstrap params would be ignored. Pick one channel per run.",
      };
    }
    if (selected.length !== 1) {
      return {
        fileUrl,
        projectRoot,
        vars,
        secrets,
        results: [],
        summary: { total: 0, passed: 0, failed: 0 },
        error:
          `inputJson / bootstrapInput / forceStandalone require \`filter\` ` +
          `to match exactly one testId. Matched ${selected.length} tests` +
          (selected.length > 1
            ? `: ${selected.map((t) => t.id).slice(0, 10).join(", ")}`
            : "") +
          ".",
      };
    }
    const targetTestId = selected[0]!.id;
    savedExplicitMap = process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
    savedBootstrapMap = process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
    savedForceIds = process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];
    // §8 templating env — project vars+secrets + process.env (secrets win
    // over vars; process.env wins over both, matching loadProjectEnv).
    const templatingEnv: Record<string, string | undefined> = {
      ...vars,
      ...secrets,
      ...process.env,
    };
    if (args.inputJson !== undefined) {
      const templated = applyEnvTemplating(args.inputJson, templatingEnv);
      process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"] = JSON.stringify({
        [targetTestId]: templated,
      });
    }
    if (args.bootstrapInput !== undefined) {
      const templated = applyEnvTemplating(args.bootstrapInput, templatingEnv);
      process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"] = JSON.stringify({
        [targetTestId]: templated,
      });
    }
    if (args.forceStandalone === true) {
      process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"] = JSON.stringify([
        targetTestId,
      ]);
    }
  }
  const restoreEnv = () => {
    if (!hasInputChannel) return;
    if (savedExplicitMap === undefined) {
      delete process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
    } else {
      process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"] = savedExplicitMap;
    }
    if (savedBootstrapMap === undefined) {
      delete process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
    } else {
      process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"] = savedBootstrapMap;
    }
    if (savedForceIds === undefined) {
      delete process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];
    } else {
      process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"] = savedForceIds;
    }
  };

  // Index results by testId as events stream in. Each test's events flow
  // between its `start` and `status` events; we key the accumulator by the
  // current testId observed from `start`.
  const resultsByTestId = new Map<string, LocalRunResult>();
  const accumulators = new Map<string, {
    start: number;
    logs: LocalRunResult["logs"];
    assertions: LocalRunResult["assertions"];
    traces: LocalRunResult["traces"];
    statusSuccess: boolean;
    errorMessage?: string;
    errorStack?: string;
  }>();

  const runner = new ProjectRunner({
    rootDir: projectRoot,
    sharedConfig: shared,
    vars,
    secrets,
    tests: facadeTests,
    sessionStartDir: testDir,
  });

  let currentTestId: string | undefined;
  // Capture orchestration-level failures so we surface them to the MCP
  // caller instead of silently returning `results: []` (which looks like
  // "no tests" success). Populated by `run:failed` / `bootstrap:failed` /
  // `session:setup:failed` events from the facade.
  let orchestrationError: string | undefined;

  try {
  for await (const evt of runner.run()) {
    // Surface non-file failure events so callers can distinguish them from
    // "clean empty run" outcomes.
    if (evt.type === "bootstrap:failed") {
      orchestrationError = `Bootstrap failed: ${evt.error.message}`;
      continue;
    }
    if (evt.type === "session:setup:failed") {
      orchestrationError = `Session setup failed${evt.error ? `: ${evt.error}` : ""}`;
      continue;
    }
    if (evt.type === "run:failed") {
      // Prefer the more specific earlier error if we already captured one.
      if (!orchestrationError) {
        orchestrationError = `Run failed (${evt.reason})${evt.error ? `: ${evt.error}` : ""}`;
      }
      continue;
    }

    if (evt.type !== "file:event") continue; // MCP only cares about test-level events below

    const event = evt.event;
    switch (event.type) {
      case "start": {
        currentTestId = event.id;
        accumulators.set(event.id, {
          start: Date.now(),
          logs: [],
          assertions: [],
          traces: [],
          statusSuccess: false,
        });
        break;
      }
      case "log": {
        if (!includeLogs || !currentTestId) break;
        const acc = accumulators.get(currentTestId);
        if (acc) acc.logs.push({ message: event.message, data: event.data });
        break;
      }
      case "assertion": {
        if (!currentTestId) break;
        const acc = accumulators.get(currentTestId);
        if (acc) {
          acc.assertions.push({
            passed: event.passed,
            message: event.message,
            actual: event.actual,
            expected: event.expected,
          });
        }
        break;
      }
      case "trace": {
        if (!includeTraces || !currentTestId) break;
        const acc = accumulators.get(currentTestId);
        if (acc) acc.traces.push(stripTraceHeaders(event.data, traceConfig));
        break;
      }
      case "status": {
        if (!currentTestId) break;
        const acc = accumulators.get(currentTestId);
        if (!acc) break;
        acc.statusSuccess = event.status === "completed";
        if (event.error) acc.errorMessage = event.error;
        if (event.stack) acc.errorStack = event.stack;

        // Finalize this test's result.
        const allAssertionsPassed = acc.assertions.every((a) => a.passed);
        const success = acc.statusSuccess && allAssertionsPassed && !acc.errorMessage;
        const testMeta = selected.find((t) => t.id === currentTestId);
        const result: LocalRunResult = {
          exportName: testMeta?.exportName ?? "",
          id: currentTestId,
          name: testMeta?.name ?? currentTestId,
          success,
          durationMs: Date.now() - acc.start,
          assertions: acc.assertions,
          logs: acc.logs,
          traces: acc.traces,
          error: acc.errorMessage
            ? { message: acc.errorMessage, stack: acc.errorStack }
            : undefined,
        };
        resultsByTestId.set(currentTestId, result);
        currentTestId = undefined;
        break;
      }
      case "error": {
        if (!currentTestId) break;
        const acc = accumulators.get(currentTestId);
        if (acc && !acc.errorMessage) acc.errorMessage = event.message;
        break;
      }
    }
  }
  } finally {
    restoreEnv();
  }

  // Preserve the original `selected` order (also matches AI-agent
  // expectation: results in the order they were listed).
  const results: LocalRunResult[] = [];
  for (const t of selected) {
    const r = resultsByTestId.get(t.id);
    if (r) results.push(r);
  }

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    fileUrl,
    projectRoot,
    vars,
    secrets,
    results,
    summary: { total: results.length, passed, failed },
    ...(orchestrationError !== undefined && { error: orchestrationError }),
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
    const { tests, errors } = await discoverTestsFromFile(filePath);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            tests,
            ...(errors && errors.length > 0 ? { errors } : {}),
          }),
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
      inputJson: z
        .unknown()
        .optional()
        .describe(
          "Spike 3 attachment-model §8 — explicit case input. Validated against the case's `needs` schema; runs raw (overlay skipped). Requires `filter` to match exactly one testId.",
        ),
      bootstrapInput: z
        .unknown()
        .optional()
        .describe(
          "Spike 3 attachment-model §8 — bootstrap params. Validated against the overlay's `params` schema; passed to overlay's run(ctx, params). Requires `filter` to match exactly one testId.",
        ),
      forceStandalone: z
        .boolean()
        .optional()
        .describe(
          "DEBUG: bypass `runnability.requireAttachment` for the filtered case. Author-debug only; runtime emits a warning.",
        ),
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
    inputJson?: unknown;
    bootstrapInput?: unknown;
    forceStandalone?: boolean;
  }) => {
    const result = await runLocalTestsFromFile({
      filePath: input.filePath,
      filter: input.filter,
      envFile: input.envFile,
      includeLogs: input.includeLogs,
      includeTraces: input.includeTraces,
      stopOnFailure: input.stopOnFailure,
      concurrency: input.concurrency,
      inputJson: input.inputJson,
      bootstrapInput: input.bootstrapInput,
      forceStandalone: input.forceStandalone,
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
    // Bootstrap project plugins so non-HTTP protocol contract extraction works.
    await bootstrap(rootDir);
    const result = await sharedExtractFromProject(rootDir);
    const { errors } = result;
    // Translate new-shape contracts to legacy HTTP view (§P4 shim).
    const contracts = toLegacyHttpContracts(result.contracts);

    if (contracts.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "No contracts found. Ensure .contract.ts files exist and use contract.http.with().",
            ...(errors.length > 0 ? { importErrors: errors } : {}),
          }),
        }],
      };
    }

    // Group by instanceName → feature (instance-aware grouping)
    const featureMap = new Map<string, LegacyHttpContract[]>();
    for (const c of contracts) {
      const key = c.instanceName
        ? `${c.instanceName}:${c.feature ?? c.target}`
        : (c.feature ?? c.target);
      if (!featureMap.has(key)) featureMap.set(key, []);
      featureMap.get(key)!.push(c);
    }

    let totalCases = 0;
    let deferredCases = 0;
    let deprecatedCases = 0;
    let gatedCases = 0;
    for (const c of contracts) {
      for (const cas of c.cases) {
        totalCases++;
        if (cas.lifecycle === "deprecated") deprecatedCases++;
        else if (cas.lifecycle === "deferred") deferredCases++;
        else if (cas.requires === "browser" || cas.requires === "out-of-band") gatedCases++;
      }
    }

    const output = {
      features: Array.from(featureMap.entries()).map(([name, group]) => ({
        name,
        contracts: group.map((c) => ({
          id: c.id,
          target: c.target,
          protocol: c.protocol,
          description: c.description,
          feature: c.feature,
          instanceName: c.instanceName,
          security: c.security,
          cases: c.cases.map((cas) => ({
            key: cas.key,
            description: cas.description,
            lifecycle: cas.lifecycle,
            severity: cas.severity,
            status: (cas.protocolExpect as any)?.status,
          })),
        })),
      })),
      summary: {
        total: totalCases,
        active: totalCases - deferredCases - deprecatedCases - gatedCases,
        deferred: deferredCases,
        deprecated: deprecatedCases,
        gated: gatedCases,
      },
      ...(errors.length > 0 ? { errors } : {}),
    };

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(output, null, 2),
      }],
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
// Runtime contract extraction — delegated to @glubean/scanner
// =============================================================================

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
    // Bootstrap project plugins so non-HTTP protocol contract extraction works.
    await bootstrap(rootDir);
    const result = await sharedExtractFromProject(rootDir);

    if (result.contracts.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "No contracts found. Ensure .contract.ts files exist and use contract.http.with().",
            ...(result.errors.length > 0 ? { importErrors: result.errors } : {}),
          }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          contracts: result.contracts,
          ...(result.errors.length > 0 ? { errors: result.errors } : {}),
        }, null, 2),
      }],
    };
  },
);

// =============================================================================
// OpenAPI spec generation from runtime contract data
// =============================================================================

/**
 * Map HttpSecurityScheme to OpenAPI securitySchemes entry + scheme name.
 * Uses instanceName to disambiguate when multiple instances use different
 * apiKey/oauth2 configurations (bearer/basic are canonical and shared).
 */
function securityToOpenApi(security: unknown, instanceName?: string): { name: string; scheme: Record<string, unknown> } | null {
  if (!security) return null;
  if (security === "bearer") return { name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } };
  if (security === "basic") return { name: "basicAuth", scheme: { type: "http", scheme: "basic" } };
  if (typeof security === "object" && security !== null) {
    const s = security as Record<string, unknown>;
    const suffix = instanceName ? `_${instanceName}` : "";
    if (s.type === "apiKey") return { name: `apiKeyAuth${suffix}`, scheme: { type: "apiKey", name: s.name, in: s.in } };
    if (s.type === "oauth2") return { name: `oauth2Auth${suffix}`, scheme: { type: "oauth2", flows: s.flows } };
  }
  return null;
}

/**
 * Walk an extracted flow projection and annotate matching OpenAPI operations
 * with `x-glubean-flow-sequence` extensions. Only flows where every step is
 * a `contract-call` with `protocol === "http"` are emitted — mixed-protocol
 * or compute-heavy flows are skipped (extension is path-keyed and only
 * makes sense for all-HTTP flows).
 *
 * Extension shape per operation:
 *   x-glubean-flow-sequence: [{ flowId, step, totalSteps, stepName? }, ...]
 * Operations referenced by multiple flows receive multiple entries.
 */
export function injectFlowSequenceExtensions(
  spec: Record<string, unknown>,
  flows: Array<{
    id: string;
    steps: Array<{
      kind: "contract-call" | "compute";
      name?: string;
      protocol?: string;
      target?: string;
    }>;
  }>,
): void {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, any>>;
  for (const flow of flows) {
    const httpSteps = flow.steps.filter(
      (s) => s.kind === "contract-call" && s.protocol === "http",
    );
    // Require ALL steps to be HTTP contract-calls (no compute, no other protocols)
    if (httpSteps.length !== flow.steps.length || httpSteps.length === 0) continue;

    const total = httpSteps.length;
    httpSteps.forEach((step, idx) => {
      if (!step.target) return;
      const m = step.target.match(
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i,
      );
      if (!m) return;
      const method = m[1].toLowerCase();
      const path = m[2];
      const pathEntry = paths[path];
      if (!pathEntry) return;
      const operation = pathEntry[method];
      if (!operation || typeof operation !== "object") return;

      const existing = (operation["x-glubean-flow-sequence"] as unknown[]) ?? [];
      existing.push({
        flowId: flow.id,
        step: idx + 1,
        totalSteps: total,
        ...(step.name ? { stepName: step.name } : {}),
      });
      operation["x-glubean-flow-sequence"] = existing;
    });
  }
}

/**
 * Back-compat shim — `contractsToOpenApi` is now a thin wrapper over
 * `renderArtifact(openapiArtifact, ...)` from `@glubean/sdk`. The
 * per-contract path/operation build logic and the merge logic both moved
 * into the SDK (contract-http/openapi.ts) in CAR-1 Phase 2. MCP only keeps
 * this export for existing test fixtures that call it directly.
 *
 * The scanner-shape contract is structurally compatible with
 * `ExtractedContractProjection<unknown, unknown>` — renderArtifact
 * forwards it to HTTP adapter's `artifacts.openapi` producer.
 */
export function contractsToOpenApi(
  rawContracts: SharedExtractedContract[],
  title = "API Specification",
): Record<string, unknown> {
  return renderArtifact(
    openapiArtifact,
    rawContracts as unknown as ExtractedContractProjection<unknown, unknown>[],
    { title },
  ) as Record<string, unknown>;
}

server.registerTool(
  MCP_TOOL_NAMES.openapi,
  {
    description:
      "Generate an OpenAPI 3.1 specification from contract.http.with() definitions. " +
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
    // Bootstrap project plugins so non-HTTP protocol contract extraction works.
    await bootstrap(rootDir);
    const result = await sharedExtractFromProject(rootDir);

    if (result.contracts.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "No contracts found. Ensure .contract.ts files exist and use contract.http.with().",
            ...(result.errors.length > 0 ? { importErrors: result.errors } : {}),
          }),
        }],
      };
    }

    const spec = contractsToOpenApi(result.contracts, input.title);

    // Annotate operations referenced by all-HTTP flows with
    // `x-glubean-flow-sequence` so agents / Cloud / viewers can see which
    // endpoint plays which role in which flow. Skip flows that include
    // non-HTTP steps (the extension is path-keyed and only meaningful when
    // every step maps to an OpenAPI operation). Post-Phase 2f flows live
    // as `kind: "flow"` entries inside `result.attachments`.
    const flowsForOpenApi = result.attachments
      .filter((a): a is Extract<typeof a, { kind: "flow" }> => a.kind === "flow")
      .map((a) => a.flow);
    if (flowsForOpenApi.length > 0) {
      injectFlowSequenceExtensions(spec, flowsForOpenApi);
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ...spec,
          ...(result.errors.length > 0 ? { "x-glubean-import-errors": result.errors } : {}),
        }, null, 2),
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
