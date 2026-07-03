/**
 * Glubean MCP server (stdio).
 *
 * Purpose:
 * - Let AI agents (Cursor, etc.) run verification-as-code locally
 * - Fetch structured failures (assertions/logs/traces) for automatic fixing
 * - Optionally report runs to Glubean Cloud via the `/v1/*` ingest contract
 *   (the same contract `glubean run --upload` uses — see ./cloud.ts)
 *
 * IMPORTANT (stdio transport):
 * - Never write to stdout. Use stderr for logs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { basename, dirname, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { applyEnvTemplating, bootstrap, loadProjectEnv, LOCAL_RUN_DEFAULTS, ProjectRunner, TestExecutor, toSingleExecutionOptions } from "@glubean/runner";
import type { ProjectRunnerTest } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";
import { renderArtifact, openapiArtifact } from "@glubean/sdk";
import type { ExtractedContractProjection } from "@glubean/sdk";
import { BUILTIN_SCOPES, compileScopes, DEFAULT_GLOBAL_RULES, redactEvent } from "@glubean/redaction";
import type { CompiledScope } from "@glubean/redaction";
import {
  createScanner,
  extractFromSource,
  matchesTemplateFilter,
  matchesTemplateId,
  scan,
} from "@glubean/scanner";
import { extractContractCases } from "@glubean/scanner/static";
import {
  extractContractFromFile as sharedExtractFromFile,
  extractContractsFromProject as sharedExtractFromProject,
  type NormalizedContractMeta as SharedExtractedContract,
} from "@glubean/scanner";
import type { BundleMetadata, ExportMeta, FileMeta, ScanResult } from "@glubean/scanner";
import { MCP_PACKAGE_VERSION, DEFAULT_GENERATED_BY } from "./version.js";
import { checkSdkCompat, type CompatResult } from "./version-compat.js";
import {
  buildRunIngestBody,
  cloudFetchJson,
  envLabelFromEnvFile,
  loadUploadRedaction,
  MISSING_AUTH_MESSAGES,
  resolveCloudAuth,
  resolveDefaultTargetId,
  runIngestUrl,
  runTestEventsUrl,
  runTestResultsUrl,
  runUrl,
} from "./cloud.js";

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
  given?: string;
  hasVerify?: boolean;
  verifyRules?: unknown[];
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
        given: cs.given ?? csAny.given,
        hasVerify: cs.hasVerify ?? csAny.hasVerify,
        verifyRules: cs.verifyRules ?? csAny.verifyRules,
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

// ── MCP trace redaction ──────────────────────────────────────────────────
//
// GLU-104: the return body of `glubean_run_local_file`/`glubean_get_local_events`
// is itself a "front-end" for redaction purposes — the caller is typically an
// LLM agent, and its context window is not a trusted boundary (it may be
// logged/trained on by a model provider, or echoed back by a downstream
// agent). The old design used a hand-rolled header ALLOW-LIST whose DEFAULT
// explicitly kept `authorization`/`set-cookie` verbatim, and never touched
// request/response BODY at all — the opposite of redaction. This is replaced
// by the same `@glubean/redaction` scopes the Cloud upload path already uses
// (`cloud.ts:495`, `BUILTIN_SCOPES`) — one redaction policy for the whole
// product, not a second hand-rolled one for MCP.
//
// Two independent layers, in order:
//   1. `filterHeaders` — OPTIONAL user-configured BREADTH control (which
//      header KEYS are shown at all, via glubean.yaml `mcp.trace.keep*`).
//      Default (`undefined` keepList) is "show all header keys" — safe
//      because every value still passes through layer 2 below.
//   2. `redactEvent` — MANDATORY DEPTH control: masks sensitive VALUES
//      (authorization/cookie/set-cookie/x-api-key/proxy-authorization
//      headers, known-sensitive body keys, and pattern-matched secrets —
//      JWT/Bearer/AWS keys/GitHub tokens/etc — anywhere in headers or body).
//      Runs unconditionally, even if a project's `keepRequestHeaders`
//      config re-adds `authorization` to layer 1's allow-list: the header
//      KEY becomes visible again, but its VALUE is still masked. This layer
//      cannot be disabled by project config.

export interface McpTraceConfig {
  /** Header keys to show, in addition to whatever `redactMcpTrace` decides
   *  to mask. `undefined` (the default) means "show all keys" — there is no
   *  security reason to hide a non-sensitive header name, since sensitive
   *  VALUES are always masked by `redactMcpTrace` regardless of this list. */
  keepRequestHeaders?: string[];
  keepResponseHeaders?: string[];
}

const DEFAULT_MCP_TRACE_CONFIG: McpTraceConfig = {};

let _mcpTraceConfig: McpTraceConfig | undefined;

// Accept a header allow-list only if it's an array of strings. Anything else
// (missing key, a bare string, a non-string element) falls back to `undefined`
// ("show all keys") — the MCP server must not crash `filterHeaders` on a
// malformed glubean.yaml. The CLI's `loadProjectConfigV1` hard-errors on the
// same input, so the config mistake still surfaces on `glubean run`.
function asHeaderList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((h) => typeof h === "string")
    ? (value as string[])
    : undefined;
}

async function loadMcpTraceConfig(projectRoot: string): Promise<McpTraceConfig> {
  if (_mcpTraceConfig) return _mcpTraceConfig;
  try {
    const yamlPath = resolve(projectRoot, "glubean.yaml");
    const parsed = parseYaml(await readFile(yamlPath, "utf-8")) as
      | { mcp?: { trace?: { keepRequestHeaders?: unknown; keepResponseHeaders?: unknown } } }
      | null;
    const userConfig = parsed?.mcp?.trace;
    if (userConfig) {
      _mcpTraceConfig = {
        keepRequestHeaders: asHeaderList(userConfig.keepRequestHeaders),
        keepResponseHeaders: asHeaderList(userConfig.keepResponseHeaders),
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
  keepList: string[] | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  // No allow-list configured: keep every header key. `redactMcpTrace` still
  // masks sensitive values below — this is a breadth control, not a security
  // boundary.
  if (!keepList) return headers;
  const keep = new Set(keepList.map((h) => h.toLowerCase()));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (keep.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Compiled once at module load. `BUILTIN_SCOPES` declares the "trace" event
// scopes (`data.requestHeaders`/`data.requestBody`/`data.responseHeaders`/
// `data.responseBody`/`data.url`) with the same sensitive-key sets as
// `isSensitiveKey` elsewhere in glubean — see packages/redaction/src/defaults.ts.
const MCP_TRACE_REDACTION_SCOPES: CompiledScope[] = compileScopes({
  builtinScopes: BUILTIN_SCOPES,
  globalRules: DEFAULT_GLOBAL_RULES,
  replacementFormat: "partial",
});

export function redactMcpTrace(trace: unknown, config: McpTraceConfig): unknown {
  if (!trace || typeof trace !== "object") return trace;
  const t = trace as Record<string, unknown>;
  const filtered = {
    ...t,
    ...(t.requestHeaders !== undefined && {
      requestHeaders: filterHeaders(t.requestHeaders as Record<string, string>, config.keepRequestHeaders),
    }),
    ...(t.responseHeaders !== undefined && {
      responseHeaders: filterHeaders(t.responseHeaders as Record<string, string>, config.keepResponseHeaders),
    }),
  };
  // maxDepth 64 (matches cloud.ts:495): the engine default of 10 would replace
  // legitimately-deep non-secret response bodies with a `[REDACTED: too deep]`
  // sentinel (codex GLU-104 R1 P2). Trace bodies are already size-capped
  // upstream, so a generous depth is safe.
  const redacted = redactEvent({ type: "trace", data: filtered }, MCP_TRACE_REDACTION_SCOPES, "partial", 64);
  return (redacted as Record<string, unknown>).data;
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

// GLU-88: mirrors packages/cli/src/lib/active_env.ts's SENSITIVE_ENV_NAMES
// guard. `.glubean/active-env` is a persistent, un-TTL'd, un-warned sticky
// file — an agent (or a human) that once ran `glubean env use prod` here
// leaves every subsequent MCP tool call silently pointed at prod until
// someone runs `glubean env reset`. Kept as a small local duplicate (not a
// cross-package import) because @glubean/mcp does not depend on
// @glubean/cli and shouldn't gain that dependency just for this helper.
const SENSITIVE_ENV_NAMES = new Set(["prod", "production"]);

function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAMES.has(name.trim().toLowerCase());
}

/**
 * Thrown by `resolveEnvPath` when the active env resolves to a sensitive
 * (prod-like) name and no explicit `envFile` was given. Callers should let
 * this propagate — the MCP SDK surfaces thrown errors as a tool error
 * response, which is exactly the "loud failure instead of silent prod
 * upload" behavior GLU-88 requires.
 */
export class SensitiveActiveEnvError extends Error {
  constructor(public readonly envName: string) {
    super(
      `Active environment is "${envName}" (set via \`glubean env use ${envName}\`, ` +
        `recorded in .glubean/active-env), which looks like a production ` +
        `environment. Refusing to load it implicitly — pass an explicit envFile ` +
        `(.env.${envName}) to use it, or run \`glubean env reset\` to clear the ` +
        `active environment and fall back to .env.`,
    );
    this.name = "SensitiveActiveEnvError";
  }
}

/**
 * Resolve the env file path, checking `.glubean/active-env` when no explicit envFile is given.
 * Throws `SensitiveActiveEnvError` instead of silently resolving a prod-like
 * active-env (GLU-88) — explicit `envFile` always bypasses this check.
 */
export async function resolveEnvPath(projectRoot: string, envFile?: string): Promise<string> {
  if (envFile) return resolve(envFile);
  const activeEnv = await readActiveEnv(projectRoot);
  if (activeEnv) {
    if (isSensitiveEnvName(activeEnv)) {
      throw new SensitiveActiveEnvError(activeEnv);
    }
    return resolve(projectRoot, `.env.${activeEnv}`);
  }
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
  contracts?: unknown[],
  workflows?: unknown[],
): Promise<string> {
  // Keep ISOMORPHIC with cli/src/metadata.ts computeRootHash — the MCP
  // metadata path must report the same rootHash for the same scan inputs
  // (codex S2.6 R8 P2: this copy had drifted, hashing files only, so
  // contract/workflow projects disagreed between the CLI and MCP views).
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const parts: string[] = entries.map(([path, meta]) => `${path}:${meta.hash}`);
  if (contracts && contracts.length > 0) {
    const contractHash = createHash("sha256").update(JSON.stringify(contracts)).digest("hex");
    parts.push(`__contracts__:sha256-${contractHash}`);
  }
  if (workflows && workflows.length > 0) {
    const workflowHash = createHash("sha256").update(JSON.stringify(workflows)).digest("hex");
    parts.push(`__workflows__:sha256-${workflowHash}`);
  }
  const hash = createHash("sha256").update(parts.join("\n")).digest("hex");
  return `sha256-${hash}`;
}

async function buildMetadata(
  scanResult: ScanResult,
  options: { generatedBy: string; generatedAt?: string },
): Promise<BundleMetadata> {
  const normalizedFiles = normalizeFileMap(scanResult.files);
  const stats = deriveMetadataStats(normalizedFiles);
  const contracts = scanResult.contracts;
  const workflows = scanResult.workflows;
  const rootHash = await computeRootHash(normalizedFiles, contracts, workflows);

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
    contracts: contracts && contracts.length > 0 ? contracts : undefined,
    workflows: workflows && workflows.length > 0 ? workflows : undefined,
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
  groupId?: string;
  /** Data-driven members: group may run concurrently (drives ProjectRunner). */
  parallel?: boolean;
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
        c.cases
          // Non-runnable cases (direction: "inbound", design §9.5): the SDK
          // registered no Test — never advertise them as runnable (codex I2 R1).
          .filter((cas) => cas.runnable !== false)
          .map((cas) => ({
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
      // A vNext workflow also fails the gate closed (mirrors the CLI/scanner
      // gates; the import-clause check catches aliased imports — codex S2.6 R8).
      const hasWorkflow =
        /\bworkflow\s*\(/.test(content) ||
        /import\s[^;]*?\{[^}]*\bworkflow\b[^}]*\}/.test(content);
      const contracts = (hasHttp && !hasNonHttp && !hasWorkflow) ? extractContractCases(content) : [];
      if (contracts.length > 0) {
        tests = contracts.flatMap((contract) =>
          contract.cases
            // Static-fallback mirror of the runnable filter above.
            .filter((c) => c.direction !== "inbound")
            .map((c) => ({
            exportName: contract.exportName,
            id: `${contract.contractId}.${c.key}`,
            name: `${contract.endpoint} — ${c.key}`,
            skip: !!c.deferred || !!c.deprecated,
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

    // vNext workflows exported from a contract file are runnable simple tests —
    // emit one entry per workflow like the CLI's discoverTests does (codex
    // S2.6 R9 P2). Mutually exclusive with the error fallback above: workflows
    // only exist when the runtime import succeeded.
    // workflow.pick members are the scan import's random selection over the
    // advertised universe — emit ONE template entry per pick group (mirrors
    // the CLI; the harness's template expansion resolves it to the execution
    // import's current members) instead of scheduling every eligible example
    // as a concrete id (codex S2.12 R16 P2).
    for (const wf of result.workflows ?? []) {
      tests.push({
        exportName: wf.exportName,
        id: wf.id,
        name: wf.name,
        skip: wf.skip !== undefined,
        only: wf.only ?? false,
        tags: wf.tags ?? [],
        deferred: wf.skip,
        // ProjectRunner enables batch concurrency only when meta.parallel is
        // present — drop it here and MCP runs ignore the matrix's concurrency
        // (codex S2.12 R19 P2).
        ...(wf.groupId ? { groupId: wf.groupId } : {}),
        ...(wf.parallel ? { parallel: true } : {}),
      });
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
    // ProjectRunner gates batch concurrency on meta.parallel — static
    // discovery must return it like the CLI does (codex S2.12 R20 P2).
    parallel: m.parallel,
    groupId: m.groupId ?? (m.variant === "pick" || m.parallel ? m.id : undefined),
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
  /** True when the test called ctx.skip() at runtime. Not a pass or a fail. */
  skipped?: boolean;
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
  /** When the run finished (the snapshot is taken after completion). */
  createdAt: string;
  /** When the run started (recorded before execution) — the honest
   *  `startedAt` for the Cloud upload envelope. */
  startedAt: string;
  /** Stable idempotency id for Cloud upload — re-uploading the SAME snapshot
   *  replaces the Cloud run instead of duplicating it. */
  clientRunId: string;
  fileUrl: string;
  projectRoot: string;
  summary: { total: number; passed: number; failed: number; skipped: number };
  results: LocalRunResult[];
  includeLogs: boolean;
  includeTraces: boolean;
  filter?: string;
  /** The envFile argument the run was executed with (env label provenance). */
  envFile?: string;
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
  summary: { total: number; passed: number; failed: number; skipped: number };
  /**
   * The RESOLVED env file path this run used (explicit envFile, else
   * `.glubean/active-env`, else `.env`). Recorded on the snapshot so a later
   * Cloud upload sources credentials + the environment label from the env
   * the run ACTUALLY used — even if active-env changes in between (codex
   * GLU-77 R3). Absent only on the version-skew early return (no run).
   */
  envPath?: string;
  error?: string;
  /** Runner-fallback or protocol warnings emitted by the executor. (Plan 1 AC6) */
  warnings?: string[];
  /**
   * SDK / runner version compat probe result (Plan 3).
   * Always populated. When `ok: false`, tests were NOT run because we
   * detected a dual-package hazard that would have produced misleading
   * errors. See `versionInfo.message` for the install command.
   */
  versionInfo?: CompatResult;
}> {
  const absolutePath = resolve(args.filePath);
  const testDir = dirname(absolutePath);
  const projectRoot = await findProjectRoot(testDir);

  // Plan 3: SDK / runner version-skew probe. Fires BEFORE we spawn the
  // harness so an unrecoverable dual-package hazard (project has @glubean/sdk
  // pinned at a different version + no @glubean/runner installed → Plan 1's
  // fallback path can't produce a hazard-free spawn) is reported as a
  // structured `sdk_version_skew` error instead of a misleading runtime
  // error inside the test. Plan 1's runner fix transparently handles the
  // common case (project-local runner present); this probe only short-
  // circuits the residual sdk-only scenario.
  const versionInfo = checkSdkCompat(projectRoot);
  if (!versionInfo.ok) {
    const fileUrl = pathToFileURL(absolutePath).href;
    return {
      fileUrl,
      projectRoot,
      vars: {},
      secrets: {},
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      // Failure class differentiates the two `ok: false` paths in checkSdkCompat:
      //   - "sdk_version_skew" — recoverable; user installs @glubean/runner
      //   - "mcp_packaging_bug" — MCP itself broken; file an issue
      error: versionInfo.failureCode ?? "sdk_version_skew",
      versionInfo,
    };
  }

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
    return haystack.includes(normalizedFilter) ||
      matchesTemplateFilter(t.id, normalizedFilter);
  });

  if (selected.length === 0) {
    return {
      fileUrl,
      projectRoot,
      vars,
      secrets,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      envPath,
      error: tests.length === 0
        ? "No tests discovered in file. Check that exports use test() or contract.http.with() from @glubean/sdk."
        : `No tests matched filter "${args.filter}". Available: ${tests.map((t) => t.id).join(", ")}`,
      ...(discoveryErrors && discoveryErrors.length > 0 ? { importErrors: discoveryErrors } : {}),
      versionInfo,
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
      groupId: t.groupId,
      parallel: t.parallel,
      only: t.only,
      skip: t.skip,
    } as ProjectRunnerTest["meta"],
  }));

  // ── Spike 3 runner input channels (attachment-model §8) ─────────────────
  // The harness reads `GLUBEAN_RUNNER_*` env vars and populates the SDK's
  // runner-input channel. MCP is a long-lived server, so these values are
  // attached to the per-run executor env instead of process.env.
  const hasInputChannel =
    args.inputJson !== undefined ||
    args.bootstrapInput !== undefined ||
    args.forceStandalone === true;
  const runnerEnv: Record<string, string | undefined> = {
    GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP: undefined,
    GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP: undefined,
    GLUBEAN_RUNNER_FORCE_STANDALONE_IDS: undefined,
  };
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
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        envPath,
        error:
          "inputJson and bootstrapInput are mutually exclusive. " +
          "Per attachment-model §5.1: explicit input bypasses the overlay, so bootstrap params would be ignored. Pick one channel per run.",
        versionInfo,
      };
    }
    if (selected.length !== 1) {
      return {
        fileUrl,
        projectRoot,
        vars,
        secrets,
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        envPath,
        error:
          `inputJson / bootstrapInput / forceStandalone require \`filter\` ` +
          `to match exactly one testId. Matched ${selected.length} tests` +
          (selected.length > 1
            ? `: ${selected.map((t) => t.id).slice(0, 10).join(", ")}`
            : "") +
          ".",
        versionInfo,
      };
    }
    const targetTestId = selected[0]!.id;
    // §8 templating env — project vars+secrets + process.env (secrets win
    // over vars; process.env wins over both, matching loadProjectEnv).
    const templatingEnv: Record<string, string | undefined> = {
      ...vars,
      ...secrets,
      ...process.env,
    };
    if (args.inputJson !== undefined) {
      const templated = applyEnvTemplating(args.inputJson, templatingEnv);
      runnerEnv["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"] = JSON.stringify({
        [targetTestId]: templated,
      });
    }
    if (args.bootstrapInput !== undefined) {
      const templated = applyEnvTemplating(args.bootstrapInput, templatingEnv);
      runnerEnv["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"] = JSON.stringify({
        [targetTestId]: templated,
      });
    }
    if (args.forceStandalone === true) {
      runnerEnv["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"] = JSON.stringify([
        targetTestId,
      ]);
    }
  }

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
    executor: TestExecutor.fromSharedConfig(shared, {
      cwd: projectRoot,
      env: runnerEnv,
    }),
  });

  let currentTestId: string | undefined;
  // Capture orchestration-level failures so we surface them to the MCP
  // caller instead of silently returning `results: []` (which looks like
  // "no tests" success). Populated by `run:failed` / `bootstrap:failed` /
  // `session:setup:failed` events from the facade.
  let orchestrationError: string | undefined;
  // Plan 1 AC6: collect runner-fallback / protocol warnings emitted at the
  // start of every TestExecutor.run() call. Deduped by message so the same
  // warning doesn't repeat across session setup + each file's invocation.
  const warningSet = new Set<string>();

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
    // Attribution under PARALLEL batches (codex S2.12 R20 P1): every
    // test-scoped event may carry `testId`; the single mutable currentTestId
    // is only the fallback for sequential runs where it's absent. Without
    // this, interleaved events from a parallel workflow.each matrix landed on
    // whichever test started last.
    const eventTestId =
      (event as { testId?: string }).testId ?? currentTestId;
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
        if (!includeLogs || !eventTestId) break;
        const acc = accumulators.get(eventTestId);
        if (acc) acc.logs.push({ message: event.message, data: event.data });
        break;
      }
      case "assertion": {
        if (!eventTestId) break;
        const acc = accumulators.get(eventTestId);
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
        if (!includeTraces || !eventTestId) break;
        const acc = accumulators.get(eventTestId);
        if (acc) acc.traces.push(redactMcpTrace(event.data, traceConfig));
        break;
      }
      case "status": {
        if (!eventTestId) break;
        const acc = accumulators.get(eventTestId);
        if (!acc) break;
        acc.statusSuccess = event.status === "completed";
        if (event.error) acc.errorMessage = event.error;
        if (event.stack) acc.errorStack = event.stack;

        // Finalize this test's result.
        const allAssertionsPassed = acc.assertions.every((a) => a.passed);
        // A skip only counts as skipped when nothing failed before it. A failed
        // assertion (or error) is authoritative — skip must not mask it (matches
        // the executor summary and the step-path rule in the harness).
        const cleanSkip =
          event.status === "skipped" && allAssertionsPassed && !acc.errorMessage;
        const success = cleanSkip
          ? true
          : acc.statusSuccess && allAssertionsPassed && !acc.errorMessage;
        const testMeta = selected.find((t) => matchesTemplateId(t.id, eventTestId));
        const result: LocalRunResult = {
          exportName: testMeta?.exportName ?? "",
          id: eventTestId,
          name: testMeta?.name ?? eventTestId,
          success,
          ...(cleanSkip && { skipped: true }),
          durationMs: Date.now() - acc.start,
          assertions: acc.assertions,
          logs: acc.logs,
          traces: acc.traces,
          error: acc.errorMessage
            ? { message: acc.errorMessage, stack: acc.errorStack }
            : undefined,
        };
        resultsByTestId.set(eventTestId, result);
        if (currentTestId === eventTestId) currentTestId = undefined;
        break;
      }
      case "error": {
        if (!eventTestId) {
          // Subprocess crashed before starting any test (e.g. tsx failed to
          // start, syntax error before first `start` event). Capture as an
          // orchestration error so the caller sees a non-empty error field
          // instead of total:0 which looks like "no tests found" success.
          if (!orchestrationError) orchestrationError = event.message;
          break;
        }
        const acc = accumulators.get(eventTestId);
        if (acc && !acc.errorMessage) acc.errorMessage = event.message;
        break;
      }
      case "warning": {
        // Plan 1 AC6: collect runner-fallback / protocol-min warnings.
        // Discriminate by the `code` field (set by executor diagnostics
        // only — user-emitted ctx.warn(false, "...") warnings have no
        // code and are intentionally NOT surfaced at the run level since
        // they're per-test concerns, not project-wide).
        if (event.code && event.message) {
          warningSet.add(event.message);
        }
        break;
      }
    }
  }

  // Preserve the original `selected` order (also matches AI-agent
  // expectation: results in the order they were listed).
  const results: LocalRunResult[] = [];
  const emitted = new Set<string>();
  const resultValues = [...resultsByTestId.values()];
  for (const t of selected) {
    const matches = resultValues.filter((r) => matchesTemplateId(t.id, r.id));
    for (const r of matches) {
      if (emitted.has(r.id)) continue;
      emitted.add(r.id);
      results.push(r);
    }
  }

  const skippedCount = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.success && !r.skipped).length;
  const failed = results.filter((r) => !r.success).length;

  const warningsArr = [...warningSet];

  return {
    fileUrl,
    projectRoot,
    vars,
    secrets,
    results,
    summary: { total: results.length, passed, failed, skipped: skippedCount },
    envPath,
    ...(orchestrationError !== undefined && { error: orchestrationError }),
    ...(warningsArr.length > 0 && { warnings: warningsArr }),
    versionInfo,
  };
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
  openUploadRun: "glubean_open_upload_run",
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
    description: "Run Glubean test exports from a file locally and return structured results for AI debugging/fixing. When includeTraces is true, each trace includes responseSchema (inferred JSON Schema) and truncated, redacted responseBody (secrets masked) — use responseSchema to understand response structure without reading full data.",
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
        .describe("Include HTTP traces with responseSchema (inferred JSON Schema) and truncated, redacted responseBody (secrets masked). Use this to understand API response structure. Default: false."),
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
    // Recorded BEFORE execution — the snapshot's honest startedAt for Cloud
    // upload (createdAt below is the run's END; codex GLU-77 R1 P2).
    const runStartedAt = new Date().toISOString();
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
    // Plan 1 AC6: forward runner-fallback / protocol warnings to the agent
    // so it can surface version-skew misconfigurations instead of leaving
    // the user with mysterious "configure() values" errors.
    if (result.warnings && result.warnings.length > 0) {
      safe.warnings = result.warnings;
    }
    // Plan 3: forward structured compat info. Always include — even when
    // tests ran successfully — so the agent has full SDK/runner version
    // context if it wants to render it.
    if (result.versionInfo) {
      safe.versionInfo = result.versionInfo;
    }

    lastLocalRunSnapshot = {
      createdAt: new Date().toISOString(),
      startedAt: runStartedAt,
      clientRunId: randomUUID(),
      fileUrl: result.fileUrl,
      projectRoot: result.projectRoot,
      summary: result.summary,
      results: result.results,
      includeLogs: input.includeLogs ?? true,
      includeTraces: input.includeTraces ?? false,
      filter: input.filter,
      // The RESOLVED env path the run used (handles .glubean/active-env) —
      // NOT the raw input, so a later upload can't re-resolve to a DIFFERENT
      // active env than the run's (codex GLU-77 R3 P2). Falls back to the raw
      // input only on the version-skew early return (no run happened).
      ...(result.envPath ?? input.envFile
        ? { envFile: result.envPath ?? input.envFile }
        : {}),
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
            given: cas.given,
            hasVerify: cas.hasVerify,
            verifyRules: cas.verifyRules,
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

// =============================================================================
// Cloud open* tools — /v1 ingest contract (GLU-77)
//
// The legacy Open Platform (`/open/v1/*` — server-side bundle execution) was
// retired with the old stack. These tools speak the new platform API: runs
// execute LOCALLY (glubean_run_local_file), then results are reported via
// `POST /v1/projects/{projectId}/targets/{targetId}/runs` — the same ingest
// contract and credential conventions as `glubean run --upload`.
// =============================================================================

const OPEN_AUTH_INPUT_SCHEMA = {
  apiUrl: z
    .string()
    .optional()
    .describe(
      "Platform API base URL (default: GLUBEAN_API_URL, or https://api.glubean.com)",
    ),
  token: z
    .string()
    .optional()
    .describe(
      "API token (default: GLUBEAN_TOKEN from process env or .env.secrets, else ~/.glubean/credentials.json)",
    ),
  projectId: z
    .string()
    .optional()
    .describe(
      "Project id (default: GLUBEAN_PROJECT_ID from process env or .env, else ~/.glubean/credentials.json)",
    ),
  targetId: z
    .string()
    .optional()
    .describe(
      "Target id within the project (default: GLUBEAN_TARGET_ID, else the project's default target)",
    ),
  dir: z
    .string()
    .optional()
    .describe(
      "Project root for .env/.env.secrets credential resolution (default: the last run snapshot's project root, else cwd)",
    ),
  envFile: z
    .string()
    .optional()
    .describe("Path to .env file (default: <projectRoot>/.env)"),
};

interface OpenToolAuthInput {
  apiUrl?: string;
  token?: string;
  projectId?: string;
  targetId?: string;
  dir?: string;
  envFile?: string;
}

/**
 * Resolve Cloud credentials for the open* tools with the CLI's precedence
 * (explicit arg > process env > project .env/.env.secrets >
 * ~/.glubean/credentials.json), then require the full token/project/target
 * set — resolving the project's DEFAULT target when none is configured.
 * Returns a human-actionable error message when a piece is missing.
 */
async function requireOpenToolAuth(
  input: OpenToolAuthInput,
  fallbackRoot?: string,
): Promise<
  | { ok: true; auth: { apiUrl: string; token: string; projectId: string; targetId: string } }
  | { ok: false; error: string }
> {
  const projectRoot = input.dir ? resolve(input.dir) : (fallbackRoot ?? process.cwd());
  const envPath = await resolveEnvPath(projectRoot, input.envFile);
  const { vars, secrets } = await loadProjectEnv(projectRoot, basename(envPath));
  const auth = await resolveCloudAuth(input, {
    envFileVars: { ...vars, ...secrets },
  });
  if (!auth.token) return { ok: false, error: MISSING_AUTH_MESSAGES.token };
  if (!auth.projectId) return { ok: false, error: MISSING_AUTH_MESSAGES.projectId };
  const targetId =
    auth.targetId ??
    (await resolveDefaultTargetId(auth.apiUrl, auth.projectId, auth.token));
  if (!targetId) return { ok: false, error: MISSING_AUTH_MESSAGES.targetId };
  return {
    ok: true,
    auth: { apiUrl: auth.apiUrl, token: auth.token, projectId: auth.projectId, targetId },
  };
}

function errorContent(error: string, extra?: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error, ...extra }) },
    ],
  };
}

server.registerTool(
  MCP_TOOL_NAMES.openUploadRun,
  {
    description:
      "Upload the most recent glubean_run_local_file results to Glubean Cloud " +
      "(POST /v1/projects/{projectId}/targets/{targetId}/runs — the same ingest contract as `glubean run --upload`). " +
      "Replaces the retired glubean_open_trigger_run (/open/v1): the platform ingests locally-executed runs; there is no remote trigger. " +
      "Credentials resolve like the CLI: explicit args > GLUBEAN_TOKEN / GLUBEAN_PROJECT_ID / GLUBEAN_TARGET_ID / GLUBEAN_API_URL " +
      "(process env or project .env/.env.secrets) > ~/.glubean/credentials.json.",
    inputSchema: {
      ...OPEN_AUTH_INPUT_SCHEMA,
      environment: z
        .string()
        .optional()
        .describe(
          "Environment label recorded on the run (default: GLUBEAN_ENV, else 'default')",
        ),
    },
  },
  async (input: OpenToolAuthInput & { environment?: string }) => {
    if (!lastLocalRunSnapshot) {
      return errorContent(
        "No local run snapshot to upload. Run glubean_run_local_file first, then call this tool.",
      );
    }
    if (lastLocalRunSnapshot.results.length === 0) {
      return errorContent(
        "The last local run produced no results — nothing to upload.",
      );
    }
    // Credential resolution AND the environment label default to the env file
    // the RUN was executed with — sourcing upload credentials from a different
    // env than the run (e.g. run with `.env.staging`, upload with `.env`)
    // could misroute the upload (codex GLU-77 R2 P2). An explicit `envFile`
    // argument overrides BOTH consistently.
    const effectiveEnvFile = input.envFile ?? lastLocalRunSnapshot.envFile;
    const check = await requireOpenToolAuth(
      { ...input, envFile: effectiveEnvFile },
      lastLocalRunSnapshot.projectRoot,
    );
    if (!check.ok) return errorContent(check.error);
    const { apiUrl, token, projectId, targetId } = check.auth;

    // Environment label — same chain as the CLI's resolveUploadEnvironment:
    // explicit arg > GLUBEAN_ENV > derived from the env file the RUN used
    // (`.env.staging` → "staging"; resolveEnvPath honors .glubean/active-env).
    const snapshotRoot = lastLocalRunSnapshot.projectRoot;
    const runEnvPath = await resolveEnvPath(snapshotRoot, effectiveEnvFile);
    const environment =
      input.environment ||
      process.env.GLUBEAN_ENV?.trim() ||
      envLabelFromEnvFile(runEnvPath);
    // Project redaction rules (glubean.yaml defaults.redaction) — additive on
    // the built-in baseline, matching the CLI's upload-path scrub.
    const redaction = await loadUploadRedaction(snapshotRoot);
    const body = buildRunIngestBody(lastLocalRunSnapshot, { environment, redaction });
    const json = (await cloudFetchJson(runIngestUrl(apiUrl, projectId, targetId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      token,
    })) as { id?: unknown } | null;
    const runId = typeof json?.id === "string" ? json.id : undefined;
    if (!runId) {
      return errorContent(
        "Cloud accepted the upload but the response was missing the run id.",
        { response: json },
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            runId,
            url: runUrl(apiUrl, projectId, targetId, runId),
            projectId,
            targetId,
            environment,
            summary: lastLocalRunSnapshot.summary,
          }),
        },
      ],
    };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openGetRun,
  {
    description:
      "Get a run's status + metadata from Glubean Cloud " +
      "(GET /v1/projects/{projectId}/targets/{targetId}/runs/{runId}).",
    inputSchema: {
      runId: z.string().describe("Run ID"),
      ...OPEN_AUTH_INPUT_SCHEMA,
    },
  },
  async (input: OpenToolAuthInput & { runId: string }) => {
    const check = await requireOpenToolAuth(input, lastLocalRunSnapshot?.projectRoot);
    if (!check.ok) return errorContent(check.error);
    const { apiUrl, token, projectId, targetId } = check.auth;
    const json = await cloudFetchJson(
      runUrl(apiUrl, projectId, targetId, input.runId),
      { method: "GET", token },
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(json) }] };
  },
);

server.registerTool(
  MCP_TOOL_NAMES.openGetRunEvents,
  {
    description:
      "Fetch a test's events for a Cloud run " +
      "(GET /v1/projects/{projectId}/targets/{targetId}/runs/{runId}/tests/{testId}/events). " +
      "The /v1 contract stores events per test — omit testId to list the run's tests (with their testIds) instead.",
    inputSchema: {
      runId: z.string().describe("Run ID"),
      testId: z
        .string()
        .optional()
        .describe("Test ID within the run. Omit to list the run's tests instead."),
      type: z
        .string()
        .optional()
        .describe("Filter by event type (assertion/log/error/status) — applied client-side"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Max events returned (default: 200)"),
      ...OPEN_AUTH_INPUT_SCHEMA,
    },
  },
  async (
    input: OpenToolAuthInput & {
      runId: string;
      testId?: string;
      type?: string;
      limit?: number;
    },
  ) => {
    const check = await requireOpenToolAuth(input, lastLocalRunSnapshot?.projectRoot);
    if (!check.ok) return errorContent(check.error);
    const { apiUrl, token, projectId, targetId } = check.auth;

    if (!input.testId) {
      const rows = await cloudFetchJson(
        runTestResultsUrl(apiUrl, projectId, targetId, input.runId),
        { method: "GET", token },
      );
      const empty = Array.isArray(rows) && rows.length === 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              message: empty
                ? "No per-test rows yet — the run may still be deriving " +
                  "(check the run's `derivation` field via glubean_open_get_run and retry in a few seconds)."
                : "The /v1 contract stores run events per test — pass one of these testIds to fetch its events.",
              runId: input.runId,
              tests: rows,
            }),
          },
        ],
      };
    }

    const events = await cloudFetchJson(
      runTestEventsUrl(apiUrl, projectId, targetId, input.runId, input.testId),
      { method: "GET", token },
    );
    const all = Array.isArray(events) ? events : [];
    const filtered = input.type
      ? all.filter((e) => (e as { type?: unknown } | null)?.type === input.type)
      : all;
    const limit = Math.max(1, Math.min(input.limit ?? 200, 2000));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            runId: input.runId,
            testId: input.testId,
            availableTotal: all.length,
            returned: Math.min(filtered.length, limit),
            events: filtered.slice(0, limit),
          }),
        },
      ],
    };
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
