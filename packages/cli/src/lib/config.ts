/**
 * Unified project-level configuration loader for the Glubean CLI.
 *
 * Supports composable config merging with the following priority chain:
 *
 * - No --config: defaults -> package.json "glubean" field -> CLI flags
 * - With --config: defaults -> file1 -> file2 -> ... -> fileN -> CLI flags
 *
 * When --config is specified, the automatic package.json read is skipped
 * (unless package.json is explicitly included in the --config list).
 *
 * Files named "package.json" are special-cased: only the "glubean" field
 * is extracted. All other files are treated as plain glubean config JSON.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONFIG, BUILTIN_SCOPES } from "@glubean/redaction";
import type { RedactionConfig } from "@glubean/redaction";
import { LOCAL_RUN_DEFAULTS } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";
import type { ThresholdConfig } from "@glubean/sdk";
import { SUITE_KINDS } from "@glubean/scanner";
import type { GlubeanSuiteKind } from "@glubean/scanner";

// ─────────────────────────────────────────────────────────────────────────────
// V1 PROFILE-BASED CONFIG — the canonical (and only) project config model
// ─────────────────────────────────────────────────────────────────────────────
// These types model the canonical `glubean.yaml` v1 schema (plan §"新配置文件").
// `loadProjectConfigV1` loads it; `resolveRunPlan` resolves a profile into a
// ResolvedRunPlan that runCommand consumes. The legacy package.json
// `glubean` flat-shape loader was removed in the config consolidation
// (docs/06); only the resolved `GlubeanConfig` baseline + `mergeRunOptions`
// + `resolveRedactionConfig` helpers remain below.

/** Suite = where the runner finds runnable items. */
export interface SuiteConfig {
  /** File path, directory, or glob (e.g. `./tests`, `./contracts/*.contract.ts`). */
  target: string;
  /** Which kinds of items to extract from `target`. */
  kinds: GlubeanSuiteKind[];
  /** Optional path to fixture/eval data (for demo/eval-style suites). */
  data?: string;
}

/** Selection (positive `tags` + filter/pick + always-OR `excludeTags`). */
export interface SelectionConfig {
  tags?: string[];
  /** Always-OR exclusion — any match drops the case. Independent of `tagMode`. */
  excludeTags?: string[];
  filter?: string;
  pick?: string;
  /** Default "or". Governs `tags` only; never affects `excludeTags`. */
  tagMode?: "or" | "and";
}

/** Execution-time runtime settings. */
export interface ExecutionConfig {
  failFast?: boolean;
  /** Stop after N test failures. null = never stop on count. */
  failAfter?: number | null;
  /** Per-test timeout in ms. */
  timeoutMs?: number;
  concurrency?: number;
  /** When true, skip session/runs-context initialization for tests. */
  noSession?: boolean;
}

/** Opt-in capability gates. */
export interface CapabilitiesConfig {
  browser?: boolean;
  outOfBand?: boolean;
  optIn?: boolean;
}

/** Reporter sinks. Each is independently overridable by CLI flag. */
export interface ReportersConfig {
  console?: "detailed" | "summary";
  /** JUnit XML output path (relative to project root). */
  junit?: string;
  /** Structured JSON results path. */
  resultJson?: string;
  emitFullTrace?: boolean;
  /** Infer JSON Schema from response bodies in traces (CLI: --infer-schema). */
  inferSchema?: boolean;
  /** Always truncate arrays in trace bodies for AI-friendly output (CLI: --truncate-arrays). */
  truncateArrays?: boolean;
}

/** Optional cloud upload directive (per-profile). */
export interface UploadConfig {
  enabled?: boolean;
  /**
   * Cloud project THIS profile uploads to. Must be a real project id
   * (`proj_…` / `prj_…`) — the target-scoped platform API resolves the id
   * directly (`/v1/projects/{projectId}/…`) and does NOT resolve cloud aliases
   * server-side (the legacy alias behavior is dropped in the target cutover).
   * Per-profile, so different profiles can target different projects. When
   * omitted, falls back to `--project` / `GLUBEAN_PROJECT_ID`. Takes precedence
   * over `GLUBEAN_PROJECT_ID` when both are set (and is shown in the printed
   * plan, so the destination isn't hidden).
   */
  projectId?: string;
  /**
   * Target (API/system under test) within the project that THIS profile's runs
   * belong to (runs live under a target). Accepts a target id (`tgt_…`).
   * Per-profile. When omitted, falls back to `--upload-target` /
   * `GLUBEAN_TARGET_ID`, then to the project's default target (the CLI resolves
   * a concrete id before upload — there is no null-target ingest).
   */
  targetId?: string;
  /**
   * Name of the env var (in `.env.secrets` / environment) holding the
   * auth token for THIS profile's upload — a *reference*, never the token
   * value itself (secrets never live in committed yaml). Lets different
   * profiles authenticate to different projects. When set, the token is
   * resolved exclusively from this var (after an explicit `--token`); it
   * does NOT silently fall back to `GLUBEAN_TOKEN`. Omit to use the
   * default `GLUBEAN_TOKEN` resolution chain.
   */
  tokenEnv?: string;
}

/** Profile = one named run plan. References suites by name. */
export interface ProfileConfig {
  /** Names of suites (top-level `suites:` block) this profile includes. */
  suites: string[];
  selection?: SelectionConfig;
  execution?: ExecutionConfig;
  capabilities?: CapabilitiesConfig;
  reporters?: ReportersConfig;
  upload?: UploadConfig;
  /** Metric thresholds (e.g. stricter latency gates on `ci` than `local`). */
  thresholds?: ThresholdConfig;
}

/** Top-level `defaults:` — merged into every profile before profile-specific values. */
export interface DefaultsConfig {
  envFile?: string;
  selection?: SelectionConfig;
  execution?: ExecutionConfig;
  capabilities?: CapabilitiesConfig;
  reporters?: ReportersConfig;
  redaction?: GlubeanRedactionConfigInput;
  /** Baseline metric thresholds; per-profile `thresholds` overrides per metric. */
  thresholds?: ThresholdConfig;
}

/** MCP trace header allow-lists — which headers the MCP server surfaces to agents. */
export interface McpTraceConfig {
  keepRequestHeaders?: string[];
  keepResponseHeaders?: string[];
}

/** Top-level `mcp:` — config consumed by the @glubean/mcp server (not the run path). */
export interface McpConfig {
  trace?: McpTraceConfig;
}

/**
 * One named contract projection target (`projections.contracts.<name>`).
 * Declares what `glubean contracts --projection <name>` generates: which
 * directory of contracts to scan (`suite` name OR explicit `target` path —
 * omitting both scans the project root, same as the CLI default), which
 * artifact `format` to render, an optional `title` (openapi only), and the
 * file `output` is written to (relative to the project root).
 */
export interface ContractProjectionConfig {
  /** Suite name (from top-level `suites:`) whose `target` is scanned. */
  suite?: string;
  /** Explicit directory/glob to scan — mutually exclusive with `suite`. */
  target?: string;
  /** Artifact format: `openapi`, `md-outline`, `json`, or a registered kind. */
  format: string;
  /** OpenAPI info.title — only used when `format: openapi`. */
  title?: string;
  /** File path (relative to project root) the rendered output is written to. */
  output: string;
}

/** Top-level `projections:` — declarative multi-output generation targets. */
export interface ProjectionsConfig {
  /** Named contract projection targets. `glubean contracts --projection <name>`. */
  contracts?: Record<string, ContractProjectionConfig>;
}

/** Canonical v1 project config — the entire `glubean.yaml` content. */
export interface GlubeanProjectConfigV1 {
  version: 1;
  defaults?: DefaultsConfig;
  /** Named suite definitions referenced by profiles. */
  suites: Record<string, SuiteConfig>;
  /** Named profiles. `glubean run --profile <name>` selects one. */
  profiles: Record<string, ProfileConfig>;
  /** MCP-server settings (trace header allow-lists). Read by @glubean/mcp. */
  mcp?: McpConfig;
  /** Declarative projection outputs (e.g. multi-surface OpenAPI). */
  projections?: ProjectionsConfig;
}

/**
 * ResolvedRunPlan — what a profile resolves to after merging
 * defaults → profile → CLI overrides. All required fields are populated;
 * `runCommand` consumes this (sub-task E) instead of assembling options
 * piecemeal. Selection arrays are always [] rather than undefined.
 */
export interface ResolvedRunPlan {
  /** Profile name selected (e.g. "ci"). */
  profile: string;
  /** Absolute path of the loaded `glubean.yaml`. */
  configPath: string;
  /** Suites included in the run, expanded with their definitions. */
  suites: Array<{ name: string } & SuiteConfig>;
  selection: {
    tags: string[];
    excludeTags: string[];
    filter?: string;
    pick?: string;
    tagMode: "or" | "and";
  };
  execution: {
    failFast: boolean;
    failAfter: number | null;
    timeoutMs: number;
    concurrency: number;
    noSession: boolean;
  };
  capabilities: {
    browser: boolean;
    outOfBand: boolean;
    optIn: boolean;
  };
  reporters: {
    console: "detailed" | "summary";
    junit?: string;
    resultJson?: string;
    emitFullTrace: boolean;
    inferSchema: boolean;
    truncateArrays: boolean;
  };
  upload?: UploadConfig;
  envFile: string;
  redaction: RedactionConfig;
  /**
   * Resolved metric thresholds (defaults.thresholds ∪ profile.thresholds,
   * profile wins per metric key). Always present — `{}` when none declared.
   */
  thresholds: ThresholdConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 LOADER (Phase 1 sub-task C — loadProjectConfigV1 with hard-error
// validation). Resolve + runtime wiring arrive in sub-tasks D and E.
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown by loadProjectConfigV1 — all hard validation failures use this. */
export class GlubeanConfigError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(path ? `${message}\n  in: ${path}` : message);
    this.name = "GlubeanConfigError";
  }
}

const V1_TOP_KEYS = new Set(["version", "defaults", "suites", "profiles", "mcp", "projections"]);
const V1_MCP_KEYS = new Set(["trace"]);
const V1_MCP_TRACE_KEYS = new Set(["keepRequestHeaders", "keepResponseHeaders"]);
const V1_PROJECTIONS_KEYS = new Set(["contracts"]);
const V1_CONTRACT_PROJECTION_KEYS = new Set(["suite", "target", "format", "title", "output"]);
const V1_SUITE_KEYS = new Set(["target", "kinds", "data"]);
const V1_SUITE_KINDS = new Set<string>(SUITE_KINDS);
const V1_SELECTION_KEYS = new Set([
  "tags",
  "excludeTags",
  "filter",
  "pick",
  "tagMode",
]);
const V1_EXECUTION_KEYS = new Set([
  "failFast",
  "failAfter",
  "timeoutMs",
  "concurrency",
  "noSession",
]);
const V1_CAPABILITIES_KEYS = new Set(["browser", "outOfBand", "optIn"]);
const V1_REPORTERS_KEYS = new Set([
  "console",
  "junit",
  "resultJson",
  "emitFullTrace",
  "inferSchema",
  "truncateArrays",
]);
const V1_UPLOAD_KEYS = new Set(["enabled", "projectId", "targetId", "tokenEnv", "projectAlias"]);
const V1_DEFAULTS_KEYS = new Set([
  "envFile",
  "selection",
  "execution",
  "capabilities",
  "reporters",
  "redaction",
  "thresholds",
]);
const V1_PROFILE_KEYS = new Set([
  "suites",
  "selection",
  "execution",
  "capabilities",
  "reporters",
  "upload",
  "thresholds",
]);
const V1_THRESHOLD_AGGREGATIONS = new Set([
  "avg",
  "min",
  "max",
  "p50",
  "p90",
  "p95",
  "p99",
  "count",
]);
const V1_REDACTION_KEYS = new Set([
  "sensitiveKeys",
  "customPatterns",
  "replacementFormat",
]);

function assertOnlyKnownKeys(
  obj: unknown,
  known: Set<string>,
  context: string,
  configPath: string,
): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const unknown = Object.keys(obj as Record<string, unknown>).filter(
    (k) => !known.has(k),
  );
  if (unknown.length > 0) {
    throw new GlubeanConfigError(
      `Unknown key(s) at \`${context}\`: ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
        `Allowed keys: ${[...known].join(", ")}.`,
      configPath,
    );
  }
}

function assertType(
  value: unknown,
  expected: "string" | "number" | "boolean" | "array" | "object",
  context: string,
  configPath: string,
): void {
  let ok = false;
  if (expected === "array") ok = Array.isArray(value);
  else if (expected === "object")
    ok = value !== null && typeof value === "object" && !Array.isArray(value);
  else if (expected === "number") {
    // YAML `.nan` / `.inf` / `-.inf` parse as JS numbers but are not usable
    // for execution settings (NaN concurrency → no workers, etc). Reject.
    ok = typeof value === "number" && Number.isFinite(value);
  } else ok = typeof value === expected;
  if (!ok) {
    let got: string;
    if (value === null) got = "null";
    else if (Array.isArray(value)) got = "array";
    else if (typeof value === "number" && !Number.isFinite(value)) {
      got = Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    } else got = typeof value;
    throw new GlubeanConfigError(
      `Expected \`${context}\` to be ${expected}, got ${got}.`,
      configPath,
    );
  }
}

/** Reject a present-but-blank string value (whitespace-only counts as blank). */
function assertNonEmpty(value: string, context: string, configPath: string): void {
  if (value.trim() === "") {
    throw new GlubeanConfigError(`\`${context}\` must be a non-empty string.`, configPath);
  }
}

function validateSuite(
  name: string,
  raw: unknown,
  configPath: string,
): SuiteConfig {
  assertType(raw, "object", `suites.${name}`, configPath);
  assertOnlyKnownKeys(raw, V1_SUITE_KEYS, `suites.${name}`, configPath);
  const s = raw as Record<string, unknown>;
  if (s.target === undefined) {
    throw new GlubeanConfigError(
      `Missing required field \`suites.${name}.target\`.`,
      configPath,
    );
  }
  assertType(s.target, "string", `suites.${name}.target`, configPath);
  if (s.kinds === undefined) {
    throw new GlubeanConfigError(
      `Missing required field \`suites.${name}.kinds\` ` +
        `(any of: ${[...V1_SUITE_KINDS].join(", ")}).`,
      configPath,
    );
  }
  assertType(s.kinds, "array", `suites.${name}.kinds`, configPath);
  const kinds = s.kinds as unknown[];
  if (kinds.length === 0) {
    throw new GlubeanConfigError(
      `\`suites.${name}.kinds\` cannot be empty.`,
      configPath,
    );
  }
  for (const k of kinds) {
    if (typeof k !== "string" || !V1_SUITE_KINDS.has(k)) {
      throw new GlubeanConfigError(
        `Invalid kind ${JSON.stringify(k)} in \`suites.${name}.kinds\`. ` +
          `Allowed: ${[...V1_SUITE_KINDS].join(", ")}.`,
        configPath,
      );
    }
  }
  if (s.data !== undefined) {
    assertType(s.data, "string", `suites.${name}.data`, configPath);
  }
  return {
    target: s.target as string,
    // Validated above against V1_SUITE_KINDS (= SUITE_KINDS, incl. "load").
    kinds: kinds as GlubeanSuiteKind[],
    ...(s.data !== undefined && { data: s.data as string }),
  };
}

function validateSelection(
  raw: unknown,
  context: string,
  configPath: string,
): SelectionConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, V1_SELECTION_KEYS, context, configPath);
  const s = raw as Record<string, unknown>;
  const out: SelectionConfig = {};
  if (s.tags !== undefined) {
    assertType(s.tags, "array", `${context}.tags`, configPath);
    out.tags = (s.tags as unknown[]).map((t) => {
      if (typeof t !== "string") {
        throw new GlubeanConfigError(
          `\`${context}.tags\` must be an array of strings.`,
          configPath,
        );
      }
      return t;
    });
  }
  if (s.excludeTags !== undefined) {
    assertType(s.excludeTags, "array", `${context}.excludeTags`, configPath);
    out.excludeTags = (s.excludeTags as unknown[]).map((t) => {
      if (typeof t !== "string") {
        throw new GlubeanConfigError(
          `\`${context}.excludeTags\` must be an array of strings.`,
          configPath,
        );
      }
      return t;
    });
  }
  if (s.filter !== undefined) {
    assertType(s.filter, "string", `${context}.filter`, configPath);
    out.filter = s.filter as string;
  }
  if (s.pick !== undefined) {
    assertType(s.pick, "string", `${context}.pick`, configPath);
    out.pick = s.pick as string;
  }
  if (s.tagMode !== undefined) {
    if (s.tagMode !== "or" && s.tagMode !== "and") {
      throw new GlubeanConfigError(
        `\`${context}.tagMode\` must be "or" or "and", got ${JSON.stringify(s.tagMode)}.`,
        configPath,
      );
    }
    out.tagMode = s.tagMode;
  }
  return out;
}

function assertPositiveInt(
  value: number,
  context: string,
  configPath: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GlubeanConfigError(
      `\`${context}\` must be a positive integer (≥ 1), got ${value}.`,
      configPath,
    );
  }
}

function validateExecution(
  raw: unknown,
  context: string,
  configPath: string,
): ExecutionConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, V1_EXECUTION_KEYS, context, configPath);
  const s = raw as Record<string, unknown>;
  const out: ExecutionConfig = {};
  if (s.failFast !== undefined) {
    assertType(s.failFast, "boolean", `${context}.failFast`, configPath);
    out.failFast = s.failFast as boolean;
  }
  if (s.failAfter !== undefined && s.failAfter !== null) {
    assertType(s.failAfter, "number", `${context}.failAfter`, configPath);
    // Runner stops at `failedCount >= failureLimit`. 0/negative would
    // make the profile run zero tests. Use `null` to disable the limit.
    assertPositiveInt(s.failAfter as number, `${context}.failAfter`, configPath);
    out.failAfter = s.failAfter as number;
  } else if (s.failAfter === null) {
    out.failAfter = null;
  }
  if (s.timeoutMs !== undefined) {
    assertType(s.timeoutMs, "number", `${context}.timeoutMs`, configPath);
    assertPositiveInt(s.timeoutMs as number, `${context}.timeoutMs`, configPath);
    out.timeoutMs = s.timeoutMs as number;
  }
  if (s.concurrency !== undefined) {
    assertType(s.concurrency, "number", `${context}.concurrency`, configPath);
    assertPositiveInt(s.concurrency as number, `${context}.concurrency`, configPath);
    out.concurrency = s.concurrency as number;
  }
  if (s.noSession !== undefined) {
    assertType(s.noSession, "boolean", `${context}.noSession`, configPath);
    out.noSession = s.noSession as boolean;
  }
  return out;
}

function validateBoolMap(
  raw: unknown,
  known: Set<string>,
  context: string,
  configPath: string,
): Record<string, boolean> {
  if (raw === undefined) return {};
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, known, context, configPath);
  const s = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(s)) {
    assertType(s[k], "boolean", `${context}.${k}`, configPath);
    out[k] = s[k] as boolean;
  }
  return out;
}

function validateReporters(
  raw: unknown,
  context: string,
  configPath: string,
): ReportersConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, V1_REPORTERS_KEYS, context, configPath);
  const s = raw as Record<string, unknown>;
  const out: ReportersConfig = {};
  if (s.console !== undefined) {
    if (s.console !== "detailed" && s.console !== "summary") {
      throw new GlubeanConfigError(
        `\`${context}.console\` must be "detailed" or "summary", got ${JSON.stringify(s.console)}.`,
        configPath,
      );
    }
    out.console = s.console;
  }
  if (s.junit !== undefined) {
    assertType(s.junit, "string", `${context}.junit`, configPath);
    out.junit = s.junit as string;
  }
  if (s.resultJson !== undefined) {
    assertType(s.resultJson, "string", `${context}.resultJson`, configPath);
    out.resultJson = s.resultJson as string;
  }
  if (s.emitFullTrace !== undefined) {
    assertType(s.emitFullTrace, "boolean", `${context}.emitFullTrace`, configPath);
    out.emitFullTrace = s.emitFullTrace as boolean;
  }
  if (s.inferSchema !== undefined) {
    assertType(s.inferSchema, "boolean", `${context}.inferSchema`, configPath);
    out.inferSchema = s.inferSchema as boolean;
  }
  if (s.truncateArrays !== undefined) {
    assertType(s.truncateArrays, "boolean", `${context}.truncateArrays`, configPath);
    out.truncateArrays = s.truncateArrays as boolean;
  }
  return out;
}

function validateUpload(
  raw: unknown,
  context: string,
  configPath: string,
): UploadConfig {
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, V1_UPLOAD_KEYS, context, configPath);
  const s = raw as Record<string, unknown>;
  const out: UploadConfig = {};
  if (s.enabled !== undefined) {
    assertType(s.enabled, "boolean", `${context}.enabled`, configPath);
    out.enabled = s.enabled as boolean;
  }
  if (s.projectId !== undefined) {
    assertType(s.projectId, "string", `${context}.projectId`, configPath);
    assertNonEmpty(s.projectId as string, `${context}.projectId`, configPath);
    out.projectId = s.projectId as string;
  }
  if (s.targetId !== undefined) {
    assertType(s.targetId, "string", `${context}.targetId`, configPath);
    assertNonEmpty(s.targetId as string, `${context}.targetId`, configPath);
    out.targetId = s.targetId as string;
  }
  if (s.projectAlias !== undefined) {
    // Deprecated synonym for projectId (renamed because per-profile project
    // targeting is the real model — "alias" misleadingly implied otherwise).
    assertType(s.projectAlias, "string", `${context}.projectAlias`, configPath);
    assertNonEmpty(s.projectAlias as string, `${context}.projectAlias`, configPath);
    if (out.projectId === undefined) out.projectId = s.projectAlias as string;
    console.warn(`Warning: ${context}.projectAlias is deprecated — rename to projectId.`);
  }
  if (s.tokenEnv !== undefined) {
    assertType(s.tokenEnv, "string", `${context}.tokenEnv`, configPath);
    // A blank tokenEnv would make the exclusive-token-resolution path fall
    // through to GLUBEAN_TOKEN — the silent wrong-token fallback this
    // feature exists to prevent. Reject it at load instead.
    assertNonEmpty(s.tokenEnv as string, `${context}.tokenEnv`, configPath);
    out.tokenEnv = s.tokenEnv as string;
  }
  return out;
}

function validateRedaction(
  raw: unknown,
  context: string,
  configPath: string,
): GlubeanRedactionConfigInput {
  if (raw === undefined) return {};
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, V1_REDACTION_KEYS, context, configPath);
  const r = raw as Record<string, unknown>;
  const out: GlubeanRedactionConfigInput = {};
  if (r.sensitiveKeys !== undefined) {
    assertType(r.sensitiveKeys, "array", `${context}.sensitiveKeys`, configPath);
    out.sensitiveKeys = (r.sensitiveKeys as unknown[]).map((k, i) => {
      if (typeof k !== "string") {
        throw new GlubeanConfigError(
          `\`${context}.sensitiveKeys[${i}]\` must be a string, got ${typeof k}.`,
          configPath,
        );
      }
      return k;
    });
  }
  if (r.customPatterns !== undefined) {
    assertType(r.customPatterns, "array", `${context}.customPatterns`, configPath);
    out.customPatterns = (r.customPatterns as unknown[]).map((p, i) => {
      const ctx = `${context}.customPatterns[${i}]`;
      assertType(p, "object", ctx, configPath);
      assertOnlyKnownKeys(p, new Set(["name", "regex"]), ctx, configPath);
      const obj = p as Record<string, unknown>;
      if (typeof obj.name !== "string") {
        throw new GlubeanConfigError(
          `\`${ctx}.name\` is required and must be a string.`,
          configPath,
        );
      }
      if (typeof obj.regex !== "string") {
        throw new GlubeanConfigError(
          `\`${ctx}.regex\` is required and must be a string.`,
          configPath,
        );
      }
      // Compile regex eagerly so malformed patterns fail at load time.
      try {
        new RegExp(obj.regex);
      } catch (err) {
        throw new GlubeanConfigError(
          `\`${ctx}.regex\` is not a valid regular expression: ${(err as Error).message}`,
          configPath,
        );
      }
      return { name: obj.name, regex: obj.regex };
    });
  }
  if (r.replacementFormat !== undefined) {
    if (
      r.replacementFormat !== "simple" &&
      r.replacementFormat !== "labeled" &&
      r.replacementFormat !== "partial"
    ) {
      throw new GlubeanConfigError(
        `\`${context}.replacementFormat\` must be "simple", "labeled", or "partial", got ${JSON.stringify(r.replacementFormat)}.`,
        configPath,
      );
    }
    out.replacementFormat = r.replacementFormat;
  }
  return out;
}

function validateThresholds(
  raw: unknown,
  context: string,
  configPath: string,
): ThresholdConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", context, configPath);
  const t = raw as Record<string, unknown>;
  const out: ThresholdConfig = {};
  for (const metric of Object.keys(t)) {
    const value = t[metric];
    const ctx = `${context}.${metric}`;
    // Shorthand: a bare string is the expression for the `avg` aggregation.
    if (typeof value === "string") {
      out[metric] = value;
      continue;
    }
    // Otherwise: a map of aggregation → expression string.
    assertType(value, "object", ctx, configPath);
    assertOnlyKnownKeys(value, V1_THRESHOLD_AGGREGATIONS, ctx, configPath);
    const rules = value as Record<string, unknown>;
    const metricRules: Record<string, string> = {};
    for (const agg of Object.keys(rules)) {
      if (typeof rules[agg] !== "string") {
        throw new GlubeanConfigError(
          `\`${ctx}.${agg}\` must be a threshold expression string (e.g. "<200"), got ${typeof rules[agg]}.`,
          configPath,
        );
      }
      metricRules[agg] = rules[agg] as string;
    }
    out[metric] = metricRules as ThresholdConfig[string];
  }
  return out;
}

function validateProfile(
  name: string,
  raw: unknown,
  suiteNames: Set<string>,
  configPath: string,
): ProfileConfig {
  assertType(raw, "object", `profiles.${name}`, configPath);
  assertOnlyKnownKeys(raw, V1_PROFILE_KEYS, `profiles.${name}`, configPath);
  const p = raw as Record<string, unknown>;
  if (p.suites === undefined) {
    throw new GlubeanConfigError(
      `Missing required field \`profiles.${name}.suites\` (array of suite names).`,
      configPath,
    );
  }
  assertType(p.suites, "array", `profiles.${name}.suites`, configPath);
  const suites = (p.suites as unknown[]).map((s) => {
    if (typeof s !== "string") {
      throw new GlubeanConfigError(
        `\`profiles.${name}.suites\` must be an array of suite-name strings.`,
        configPath,
      );
    }
    if (!suiteNames.has(s)) {
      throw new GlubeanConfigError(
        `\`profiles.${name}.suites\` references undefined suite "${s}". ` +
          `Defined suites: ${[...suiteNames].join(", ") || "(none)"}.`,
        configPath,
      );
    }
    return s;
  });
  return {
    suites,
    selection: validateSelection(p.selection, `profiles.${name}.selection`, configPath),
    execution: validateExecution(p.execution, `profiles.${name}.execution`, configPath),
    capabilities: validateBoolMap(
      p.capabilities,
      V1_CAPABILITIES_KEYS,
      `profiles.${name}.capabilities`,
      configPath,
    ) as CapabilitiesConfig,
    reporters: validateReporters(p.reporters, `profiles.${name}.reporters`, configPath),
    ...(p.upload !== undefined && {
      upload: validateUpload(p.upload, `profiles.${name}.upload`, configPath),
    }),
    ...(p.thresholds !== undefined && {
      thresholds: validateThresholds(p.thresholds, `profiles.${name}.thresholds`, configPath),
    }),
  };
}

function validateDefaults(
  raw: unknown,
  configPath: string,
): DefaultsConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", "defaults", configPath);
  assertOnlyKnownKeys(raw, V1_DEFAULTS_KEYS, "defaults", configPath);
  const d = raw as Record<string, unknown>;
  const out: DefaultsConfig = {};
  if (d.envFile !== undefined) {
    assertType(d.envFile, "string", "defaults.envFile", configPath);
    out.envFile = d.envFile as string;
  }
  out.selection = validateSelection(d.selection, "defaults.selection", configPath);
  out.execution = validateExecution(d.execution, "defaults.execution", configPath);
  out.capabilities = validateBoolMap(
    d.capabilities,
    V1_CAPABILITIES_KEYS,
    "defaults.capabilities",
    configPath,
  ) as CapabilitiesConfig;
  out.reporters = validateReporters(d.reporters, "defaults.reporters", configPath);
  out.redaction = validateRedaction(d.redaction, "defaults.redaction", configPath);
  if (d.thresholds !== undefined) {
    out.thresholds = validateThresholds(d.thresholds, "defaults.thresholds", configPath);
  }
  return out;
}

function validateMcp(raw: unknown, configPath: string): McpConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", "mcp", configPath);
  assertOnlyKnownKeys(raw, V1_MCP_KEYS, "mcp", configPath);
  const m = raw as Record<string, unknown>;
  const out: McpConfig = {};
  if (m.trace !== undefined) {
    assertType(m.trace, "object", "mcp.trace", configPath);
    assertOnlyKnownKeys(m.trace, V1_MCP_TRACE_KEYS, "mcp.trace", configPath);
    const t = m.trace as Record<string, unknown>;
    const trace: McpTraceConfig = {};
    for (const key of ["keepRequestHeaders", "keepResponseHeaders"] as const) {
      if (t[key] !== undefined) {
        assertType(t[key], "array", `mcp.trace.${key}`, configPath);
        trace[key] = (t[key] as unknown[]).map((h, i) => {
          if (typeof h !== "string") {
            throw new GlubeanConfigError(
              `\`mcp.trace.${key}[${i}]\` must be a string, got ${typeof h}.`,
              configPath,
            );
          }
          return h;
        });
      }
    }
    out.trace = trace;
  }
  return out;
}

function validateContractProjection(
  name: string,
  raw: unknown,
  suiteNames: Set<string>,
  configPath: string,
): ContractProjectionConfig {
  const context = `projections.contracts.${name}`;
  assertType(raw, "object", context, configPath);
  assertOnlyKnownKeys(raw, V1_CONTRACT_PROJECTION_KEYS, context, configPath);
  const p = raw as Record<string, unknown>;

  if (p.suite !== undefined && p.target !== undefined) {
    throw new GlubeanConfigError(
      `\`${context}\` cannot set both \`suite\` and \`target\` — pick one.`,
      configPath,
    );
  }

  let suite: string | undefined;
  if (p.suite !== undefined) {
    assertType(p.suite, "string", `${context}.suite`, configPath);
    assertNonEmpty(p.suite as string, `${context}.suite`, configPath);
    if (!suiteNames.has(p.suite as string)) {
      throw new GlubeanConfigError(
        `\`${context}.suite\` references undefined suite "${p.suite}". ` +
          `Defined suites: ${[...suiteNames].join(", ") || "(none)"}.`,
        configPath,
      );
    }
    suite = p.suite as string;
  }

  let target: string | undefined;
  if (p.target !== undefined) {
    assertType(p.target, "string", `${context}.target`, configPath);
    assertNonEmpty(p.target as string, `${context}.target`, configPath);
    target = p.target as string;
  }

  if (p.format === undefined) {
    throw new GlubeanConfigError(`Missing required field \`${context}.format\`.`, configPath);
  }
  assertType(p.format, "string", `${context}.format`, configPath);
  assertNonEmpty(p.format as string, `${context}.format`, configPath);

  if (p.output === undefined) {
    throw new GlubeanConfigError(`Missing required field \`${context}.output\`.`, configPath);
  }
  assertType(p.output, "string", `${context}.output`, configPath);
  assertNonEmpty(p.output as string, `${context}.output`, configPath);

  let title: string | undefined;
  if (p.title !== undefined) {
    assertType(p.title, "string", `${context}.title`, configPath);
    title = p.title as string;
  }

  return {
    ...(suite !== undefined && { suite }),
    ...(target !== undefined && { target }),
    format: p.format as string,
    ...(title !== undefined && { title }),
    output: p.output as string,
  };
}

function validateProjections(
  raw: unknown,
  suiteNames: Set<string>,
  configPath: string,
): ProjectionsConfig {
  if (raw === undefined) return {};
  assertType(raw, "object", "projections", configPath);
  assertOnlyKnownKeys(raw, V1_PROJECTIONS_KEYS, "projections", configPath);
  const p = raw as Record<string, unknown>;
  const out: ProjectionsConfig = {};
  if (p.contracts !== undefined) {
    assertType(p.contracts, "object", "projections.contracts", configPath);
    const contractsIn = p.contracts as Record<string, unknown>;
    const contracts: Record<string, ContractProjectionConfig> = {};
    for (const name of Object.keys(contractsIn)) {
      contracts[name] = validateContractProjection(name, contractsIn[name], suiteNames, configPath);
    }
    out.contracts = contracts;
  }
  return out;
}

/**
 * Load + validate v1 project config.
 *
 * - Default path: `rootDir/glubean.yaml`
 * - Override: `options.configPath` (CLI `--config` plumbed here) — resolved
 *   against rootDir if relative. Lets users keep multiple variants on disk
 *   while still using v1 schema.
 *
 * Hard-errors on:
 * - File missing → `GlubeanConfigError("glubean.yaml not found ...")`
 * - YAML parse failure → wraps underlying error in `GlubeanConfigError`
 * - Missing/wrong `version` (must be `1`)
 * - Any unknown key at any nesting level (drops the warning behavior of the
 *   legacy loader)
 * - Missing required fields (`suites`, `profiles`, `suite.target`, `suite.kinds`,
 *   `profile.suites`)
 * - Wrong type on any field
 * - Profile that references an undefined suite name
 *
 * Returns the parsed + validated config plus the absolute path it loaded from
 * (used downstream so `ResolvedRunPlan.configPath` can be populated in sub-task D).
 */
export async function loadProjectConfigV1(
  rootDir: string,
  options: { configPath?: string } = {},
): Promise<{ config: GlubeanProjectConfigV1; configPath: string }> {
  const configPath = options.configPath
    ? resolve(rootDir, options.configPath)
    : resolve(rootDir, "glubean.yaml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new GlubeanConfigError(
        `glubean.yaml not found at ${configPath}. ` +
          `Run \`glubean init\` to create one, or pass \`--config <path>\` ` +
          `to load from a different location.`,
      );
    }
    throw new GlubeanConfigError(
      `Failed to read glubean.yaml: ${(err as Error).message}`,
      configPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new GlubeanConfigError(
      `Failed to parse glubean.yaml: ${(err as Error).message}`,
      configPath,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GlubeanConfigError(
      `glubean.yaml must contain a top-level mapping (got ${
        parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed
      }).`,
      configPath,
    );
  }

  const root = parsed as Record<string, unknown>;
  assertOnlyKnownKeys(root, V1_TOP_KEYS, "glubean.yaml", configPath);

  if (root.version !== 1) {
    throw new GlubeanConfigError(
      `\`version\` must be the integer \`1\` (got ${JSON.stringify(root.version)}). ` +
        `Add \`version: 1\` to the top of glubean.yaml.`,
      configPath,
    );
  }

  if (root.suites === undefined) {
    throw new GlubeanConfigError(
      `Missing required top-level field \`suites\` (map of suite name → suite config).`,
      configPath,
    );
  }
  assertType(root.suites, "object", "suites", configPath);
  const suitesIn = root.suites as Record<string, unknown>;
  const suites: Record<string, SuiteConfig> = {};
  for (const name of Object.keys(suitesIn)) {
    suites[name] = validateSuite(name, suitesIn[name], configPath);
  }

  if (root.profiles === undefined) {
    throw new GlubeanConfigError(
      `Missing required top-level field \`profiles\` (map of profile name → profile config).`,
      configPath,
    );
  }
  assertType(root.profiles, "object", "profiles", configPath);
  const profilesIn = root.profiles as Record<string, unknown>;
  const suiteNames = new Set(Object.keys(suites));
  const profiles: Record<string, ProfileConfig> = {};
  for (const name of Object.keys(profilesIn)) {
    profiles[name] = validateProfile(name, profilesIn[name], suiteNames, configPath);
  }

  const config: GlubeanProjectConfigV1 = {
    version: 1,
    defaults: validateDefaults(root.defaults, configPath),
    suites,
    profiles,
    ...(root.mcp !== undefined && { mcp: validateMcp(root.mcp, configPath) }),
    ...(root.projections !== undefined && {
      projections: validateProjections(root.projections, suiteNames, configPath),
    }),
  };

  return { config, configPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 RESOLVER (Phase 1 sub-task D — resolveRunPlan)
// Built-in defaults → config.defaults → profile → CLI overrides
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CLI-flag-shaped overrides passed to `resolveRunPlan`. A subset of fields —
 * only the ones the CLI can override. CLI flags take precedence over profile
 * and defaults. Arrays REPLACE the underlying values (not concat).
 */
export interface CliProfileOverrides {
  /**
   * CLI `--suite <name>` (repeatable). Filters the profile's `suites:` list
   * to only the named subset. Each name MUST appear in `profile.suites`
   * (not just `config.suites`); unknown names raise GlubeanConfigError.
   */
  suites?: string[];
  tags?: string[];
  excludeTags?: string[];
  tagMode?: "or" | "and";
  filter?: string;
  pick?: string;
  envFile?: string;
  failFast?: boolean;
  failAfter?: number | null;
  timeoutMs?: number;
  concurrency?: number;
  noSession?: boolean;
  includeBrowser?: boolean;
  includeOutOfBand?: boolean;
  includeOptIn?: boolean;
  consoleReporter?: "detailed" | "summary";
  junit?: string;
  resultJson?: string;
  emitFullTrace?: boolean;
  /** CLI --infer-schema */
  inferSchema?: boolean;
  /** CLI --truncate-arrays */
  truncateArrays?: boolean;
  /** CLI --upload: when true, force-enable upload regardless of profile setting. */
  uploadEnabled?: boolean;
}

/** Built-in defaults applied when neither config.defaults nor profile sets a value. */
export const RESOLVED_PLAN_BUILTIN_DEFAULTS = {
  envFile: ".env",
  selection: {
    tags: [] as string[],
    excludeTags: [] as string[],
    tagMode: "or" as "or" | "and",
  },
  execution: {
    failFast: false,
    failAfter: null as number | null,
    timeoutMs: 30000,
    concurrency: 4,
    noSession: false,
  },
  capabilities: {
    browser: false,
    outOfBand: false,
    optIn: false,
  },
  reporters: {
    console: "detailed" as "detailed" | "summary",
    emitFullTrace: false,
    inferSchema: false,
    truncateArrays: false,
  },
};

/**
 * Resolve a profile against a loaded config + optional CLI overrides.
 *
 * Throws `GlubeanConfigError` when `profileName` is not in `config.profiles`
 * (with a list of available profiles, per plan §Phase 1 acceptance).
 *
 * Merge order (later layer wins per-field; arrays REPLACE, never concat):
 *   1. Built-in defaults (RESOLVED_PLAN_BUILTIN_DEFAULTS)
 *   2. config.defaults (user's `defaults:` block)
 *   3. config.profiles[profileName] (profile-specific)
 *   4. cliOverrides (CLI flags)
 *
 * `suites` field on the profile is expanded: each name is looked up in
 * `config.suites` (loader already validated cross-refs) and returned as a
 * `{name, ...SuiteConfig}` array preserving the order from the profile.
 */
export function resolveRunPlan(
  config: GlubeanProjectConfigV1,
  configPath: string,
  profileName: string,
  cliOverrides: CliProfileOverrides = {},
): ResolvedRunPlan {
  const profile = config.profiles[profileName];
  if (!profile) {
    const available = Object.keys(config.profiles).sort();
    throw new GlubeanConfigError(
      `Profile "${profileName}" not found. Available profiles: ${
        available.length > 0 ? available.join(", ") : "(none defined)"
      }.`,
      configPath,
    );
  }
  const defaults = config.defaults ?? {};
  const builtin = RESOLVED_PLAN_BUILTIN_DEFAULTS;

  // Suites: expand profile.suites name list to full SuiteConfig+name objects.
  // CLI `--suite <name>` (cliOverrides.suites) filters the profile's list
  // to a subset. Each override name MUST appear in profile.suites — running
  // a suite the profile didn't include would change the run semantics
  // beyond a temporary override; the user is asked to either edit the
  // profile or pick a different profile.
  let effectiveSuiteNames = profile.suites;
  if (cliOverrides.suites && cliOverrides.suites.length > 0) {
    const profileSuiteSet = new Set(profile.suites);
    const unknown = cliOverrides.suites.filter((n) => !profileSuiteSet.has(n));
    if (unknown.length > 0) {
      throw new GlubeanConfigError(
        `--suite ${unknown.join(", ")} not declared in profile "${profileName}". ` +
          `Profile suites: ${profile.suites.join(", ") || "(none)"}.`,
        configPath,
      );
    }
    // Preserve override order so user-given order controls execution sequence.
    effectiveSuiteNames = cliOverrides.suites;
  }
  const suites = effectiveSuiteNames.map((name) => ({
    name,
    ...config.suites[name],
  }));

  // ── Selection ──────────────────────────────────────────────────────────
  // Arrays (tags / excludeTags) REPLACE per layer, not concat.
  const selection = {
    tags:
      cliOverrides.tags ??
      profile.selection?.tags ??
      defaults.selection?.tags ??
      builtin.selection.tags,
    excludeTags:
      cliOverrides.excludeTags ??
      profile.selection?.excludeTags ??
      defaults.selection?.excludeTags ??
      builtin.selection.excludeTags,
    tagMode:
      cliOverrides.tagMode ??
      profile.selection?.tagMode ??
      defaults.selection?.tagMode ??
      builtin.selection.tagMode,
    filter:
      cliOverrides.filter ?? profile.selection?.filter ?? defaults.selection?.filter,
    pick: cliOverrides.pick ?? profile.selection?.pick ?? defaults.selection?.pick,
  };

  // ── Execution ──────────────────────────────────────────────────────────
  // failAfter: explicit `null` from any layer means "no limit" (preserved).
  const execution = {
    failFast:
      cliOverrides.failFast ??
      profile.execution?.failFast ??
      defaults.execution?.failFast ??
      builtin.execution.failFast,
    failAfter:
      cliOverrides.failAfter !== undefined
        ? cliOverrides.failAfter
        : profile.execution?.failAfter !== undefined
          ? profile.execution.failAfter
          : defaults.execution?.failAfter !== undefined
            ? defaults.execution.failAfter
            : builtin.execution.failAfter,
    timeoutMs:
      cliOverrides.timeoutMs ??
      profile.execution?.timeoutMs ??
      defaults.execution?.timeoutMs ??
      builtin.execution.timeoutMs,
    concurrency:
      cliOverrides.concurrency ??
      profile.execution?.concurrency ??
      defaults.execution?.concurrency ??
      builtin.execution.concurrency,
    noSession:
      cliOverrides.noSession ??
      profile.execution?.noSession ??
      defaults.execution?.noSession ??
      builtin.execution.noSession,
  };

  // ── Capabilities ───────────────────────────────────────────────────────
  // CLI overrides use include* naming (--include-browser etc.) which maps
  // 1:1 to the capability gates here. CLI flag presence means "include"
  // (true); absence falls through to profile/defaults.
  const capabilities = {
    browser:
      cliOverrides.includeBrowser ??
      profile.capabilities?.browser ??
      defaults.capabilities?.browser ??
      builtin.capabilities.browser,
    outOfBand:
      cliOverrides.includeOutOfBand ??
      profile.capabilities?.outOfBand ??
      defaults.capabilities?.outOfBand ??
      builtin.capabilities.outOfBand,
    optIn:
      cliOverrides.includeOptIn ??
      profile.capabilities?.optIn ??
      defaults.capabilities?.optIn ??
      builtin.capabilities.optIn,
  };

  // ── Reporters ──────────────────────────────────────────────────────────
  // CLI overrides individual channels, not the whole reporters dict
  // (codex catch from plan: --reporter detailed shouldn't drop a profile's
  // junit/resultJson outputs).
  const reporters = {
    console:
      cliOverrides.consoleReporter ??
      profile.reporters?.console ??
      defaults.reporters?.console ??
      builtin.reporters.console,
    junit: cliOverrides.junit ?? profile.reporters?.junit ?? defaults.reporters?.junit,
    resultJson:
      cliOverrides.resultJson ??
      profile.reporters?.resultJson ??
      defaults.reporters?.resultJson,
    emitFullTrace:
      cliOverrides.emitFullTrace ??
      profile.reporters?.emitFullTrace ??
      defaults.reporters?.emitFullTrace ??
      builtin.reporters.emitFullTrace,
    inferSchema:
      cliOverrides.inferSchema ??
      profile.reporters?.inferSchema ??
      defaults.reporters?.inferSchema ??
      builtin.reporters.inferSchema,
    truncateArrays:
      cliOverrides.truncateArrays ??
      profile.reporters?.truncateArrays ??
      defaults.reporters?.truncateArrays ??
      builtin.reporters.truncateArrays,
  };

  const envFile = cliOverrides.envFile ?? defaults.envFile ?? builtin.envFile;
  const redaction = resolveRedactionConfig(defaults.redaction);

  // ── Thresholds ─────────────────────────────────────────────────────────
  // Shallow per-metric merge: profile overrides defaults on metric-key
  // collision (a profile can tighten or replace a baseline metric's rules,
  // but doesn't deep-merge individual aggregations).
  const thresholds: ThresholdConfig = {
    ...(defaults.thresholds ?? {}),
    ...(profile.thresholds ?? {}),
  };

  // ── Upload ─────────────────────────────────────────────────────────────
  // CLI `--upload` flag forces enable regardless of profile. Profile-defined
  // upload (projectId + tokenEnv) takes effect unless CLI overrides enabled.
  let upload: UploadConfig | undefined = profile.upload;
  if (cliOverrides.uploadEnabled !== undefined) {
    upload = { ...(upload ?? {}), enabled: cliOverrides.uploadEnabled };
  }

  return {
    profile: profileName,
    configPath,
    suites,
    selection,
    execution,
    capabilities,
    reporters,
    ...(upload !== undefined && { upload }),
    envFile,
    redaction,
    thresholds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 CONTRACT PROJECTION RESOLVER — `glubean contracts --projection <name>`
// ─────────────────────────────────────────────────────────────────────────────

/** A `projections.contracts.<name>` entry, resolved to absolute paths. */
export interface ResolvedContractProjection {
  name: string;
  /** Absolute directory to scan for contracts. */
  dir: string;
  format: string;
  title?: string;
  /** Absolute path the rendered output is written to. */
  output: string;
}

/** Sorted names of every declared `projections.contracts.<name>` entry. */
export function listContractProjectionNames(config: GlubeanProjectConfigV1): string[] {
  return Object.keys(config.projections?.contracts ?? {}).sort();
}

/**
 * Resolve one named contract projection against a loaded config.
 *
 * Throws `GlubeanConfigError` when `name` is not declared under
 * `projections.contracts` (lists available names, mirroring
 * `resolveRunPlan`'s unknown-profile error).
 */
export function resolveContractProjection(
  config: GlubeanProjectConfigV1,
  configPath: string,
  rootDir: string,
  name: string,
): ResolvedContractProjection {
  const entry = config.projections?.contracts?.[name];
  if (!entry) {
    const available = listContractProjectionNames(config);
    throw new GlubeanConfigError(
      `Contract projection "${name}" not found. ` +
        `Available: ${available.length > 0 ? available.join(", ") : "(none defined)"}.`,
      configPath,
    );
  }
  const dir = entry.suite
    ? resolve(rootDir, config.suites[entry.suite].target)
    : entry.target
      ? resolve(rootDir, entry.target)
      : rootDir;
  return {
    name,
    dir,
    format: entry.format,
    ...(entry.title !== undefined && { title: entry.title }),
    output: resolve(rootDir, entry.output),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY (pre-v1) — kept during Phase 1 transition; removed in Phase 6
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ────────────────────────────────────────────────────────────────────

/** Run-related configuration (resolved — all fields have values). */
export interface GlubeanRunConfig {
  verbose: boolean;
  pretty: boolean;
  logFile: boolean;
  emitFullTrace: boolean;
  inferSchema: boolean;
  truncateArrays: boolean;
  envFile: string;
  failFast: boolean;
  failAfter: number | null;
  /** Directory containing permanent test files (default: "./tests") */
  testDir: string;
  /** Directory containing exploratory test files (default: "./explore") */
  exploreDir: string;
  /** Per-test timeout in ms. Default: 30_000. */
  perTestTimeoutMs: number;
  concurrency: number;
}

/** Redaction config input from user files (additive fields only). */
export interface GlubeanRedactionConfigInput {
  /** Additional global sensitive keys. */
  sensitiveKeys?: string[];
  /** Custom regex patterns. */
  customPatterns?: Array<{ name: string; regex: string }>;
  /** Override replacement format. */
  replacementFormat?: "simple" | "labeled" | "partial";
}

/** Cloud connection config. */
export interface GlubeanCloudConfigInput {
  projectId?: string;
  apiUrl?: string;
  token?: string;
}

/** Fully resolved top-level config. */
export interface GlubeanConfig {
  run: GlubeanRunConfig;
  redaction: RedactionConfig;
  cloud?: GlubeanCloudConfigInput;
  thresholds?: ThresholdConfig;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const RUN_DEFAULTS: GlubeanRunConfig = {
  verbose: false,
  pretty: true,
  logFile: false,
  emitFullTrace: false,
  inferSchema: false,
  truncateArrays: false,
  envFile: ".env",
  failFast: false,
  failAfter: null,
  testDir: "./tests",
  exploreDir: "./explore",
  perTestTimeoutMs: LOCAL_RUN_DEFAULTS.perTestTimeoutMs,
  concurrency: LOCAL_RUN_DEFAULTS.concurrency,
};

export const CONFIG_DEFAULTS: GlubeanConfig = {
  run: { ...RUN_DEFAULTS },
  redaction: structuredClone(DEFAULT_CONFIG),
};

/**
 * Apply a `GlubeanRedactionConfigInput` (glubean.yaml `defaults.redaction`)
 * on top of the mandatory DEFAULT_CONFIG baseline to produce a fully
 * resolved RedactionConfig.
 */
export function resolveRedactionConfig(
  input?: GlubeanRedactionConfigInput,
): RedactionConfig {
  const merged: RedactionConfig = structuredClone(DEFAULT_CONFIG);

  if (!input) return merged;

  if (input.sensitiveKeys) {
    for (const key of input.sensitiveKeys) {
      if (
        typeof key === "string" &&
        !merged.globalRules.sensitiveKeys.includes(key)
      ) {
        merged.globalRules.sensitiveKeys.push(key);
      }
    }
  }

  if (input.customPatterns && Array.isArray(input.customPatterns)) {
    for (const pattern of input.customPatterns) {
      if (
        pattern &&
        typeof pattern.name === "string" &&
        typeof pattern.regex === "string"
      ) {
        merged.globalRules.customPatterns.push({
          name: pattern.name,
          regex: pattern.regex,
        });
      }
    }
  }

  if (
    input.replacementFormat === "simple" ||
    input.replacementFormat === "labeled" ||
    input.replacementFormat === "partial"
  ) {
    merged.replacementFormat = input.replacementFormat;
  }

  return merged;
}

/**
 * Merge resolved run config with CLI flags.
 */
export function mergeRunOptions(
  config: GlubeanRunConfig,
  cliFlags: Record<string, unknown>,
): GlubeanRunConfig {
  const result = { ...config };

  if (cliFlags.verbose !== undefined) result.verbose = !!cliFlags.verbose;
  if (cliFlags.pretty !== undefined) result.pretty = !!cliFlags.pretty;
  if (cliFlags.logFile !== undefined) result.logFile = !!cliFlags.logFile;
  if (cliFlags.emitFullTrace !== undefined) {
    result.emitFullTrace = !!cliFlags.emitFullTrace;
  }
  if (cliFlags.envFile !== undefined) result.envFile = String(cliFlags.envFile);
  if (cliFlags.failFast !== undefined) result.failFast = !!cliFlags.failFast;
  if (cliFlags.failAfter !== undefined) {
    result.failAfter = cliFlags.failAfter === null ? null : Number(cliFlags.failAfter);
  }
  if (cliFlags.testDir !== undefined) result.testDir = String(cliFlags.testDir);
  if (cliFlags.exploreDir !== undefined) {
    result.exploreDir = String(cliFlags.exploreDir);
  }
  if (cliFlags.timeout !== undefined) {
    result.perTestTimeoutMs = Number(cliFlags.timeout);
  }
  // Phase 1 sub-task E: profile-driven trace + execution fields. Without
  // these, profile reporters.inferSchema / truncateArrays + execution.timeoutMs
  // / concurrency would be silently ignored by the runner.
  if (cliFlags.inferSchema !== undefined) {
    result.inferSchema = !!cliFlags.inferSchema;
  }
  if (cliFlags.truncateArrays !== undefined) {
    result.truncateArrays = !!cliFlags.truncateArrays;
  }
  if (cliFlags.timeoutMs !== undefined) {
    result.perTestTimeoutMs = Number(cliFlags.timeoutMs);
  }
  if (cliFlags.concurrency !== undefined) {
    result.concurrency = Number(cliFlags.concurrency);
  }

  return result;
}

/**
 * Convert a resolved GlubeanRunConfig to a SharedRunConfig
 * suitable for TestExecutor.fromSharedConfig().
 */
export function toSharedRunConfig(config: GlubeanRunConfig): SharedRunConfig {
  return {
    failFast: config.failFast,
    failAfter: config.failAfter ?? undefined,
    perTestTimeoutMs: config.perTestTimeoutMs,
    concurrency: config.concurrency,
    emitFullTrace: config.emitFullTrace,
    inferSchema: config.inferSchema ?? false,
    truncateArrays: config.truncateArrays ?? false,
  };
}
