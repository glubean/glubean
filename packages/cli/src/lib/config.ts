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

import { resolve, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONFIG, BUILTIN_SCOPES } from "@glubean/redaction";
import type { RedactionConfig } from "@glubean/redaction";
import { LOCAL_RUN_DEFAULTS } from "@glubean/runner";
import type { SharedRunConfig } from "@glubean/runner";
import type { ThresholdConfig } from "@glubean/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// V1 PROFILE-BASED CONFIG (Phase 1 sub-task B — new shape, not yet wired)
// ─────────────────────────────────────────────────────────────────────────────
// These types model the canonical `glubean.yaml` v1 schema (plan §"新配置文件").
// Loading + resolution arrive in sub-task C (loadProjectConfigV1) and sub-task D
// (resolveRunPlan). runCommand starts consuming ResolvedRunPlan in sub-task E.
// The legacy GlubeanConfig + loadConfig() below stay in place during Phase 1
// transition; Phase 6 cleans them up.

/** Suite = where the runner finds runnable items. */
export interface SuiteConfig {
  /** File path, directory, or glob (e.g. `./tests`, `./contracts/*.contract.ts`). */
  target: string;
  /** Which kinds of items to extract from `target`. */
  kinds: Array<"test" | "contract" | "flow">;
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
}

/** Optional cloud upload directive (per-profile). */
export interface UploadConfig {
  enabled?: boolean;
  /** Project alias on cloud (resolves to projectId via cloud lookup). */
  projectAlias?: string;
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
}

/** Top-level `defaults:` — merged into every profile before profile-specific values. */
export interface DefaultsConfig {
  envFile?: string;
  selection?: SelectionConfig;
  execution?: ExecutionConfig;
  capabilities?: CapabilitiesConfig;
  reporters?: ReportersConfig;
  redaction?: GlubeanRedactionConfigInput;
}

/** Canonical v1 project config — the entire `glubean.yaml` content. */
export interface GlubeanProjectConfigV1 {
  version: 1;
  defaults?: DefaultsConfig;
  /** Named suite definitions referenced by profiles. */
  suites: Record<string, SuiteConfig>;
  /** Named profiles. `glubean run --profile <name>` selects one. */
  profiles: Record<string, ProfileConfig>;
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
  };
  upload?: UploadConfig;
  envFile: string;
  redaction: RedactionConfig;
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

/** Partial run config as read from a file (all fields optional). */
export interface GlubeanRunConfigInput {
  verbose?: boolean;
  pretty?: boolean;
  logFile?: boolean;
  emitFullTrace?: boolean;
  inferSchema?: boolean;
  truncateArrays?: boolean;
  envFile?: string;
  failFast?: boolean;
  failAfter?: number | null;
  testDir?: string;
  exploreDir?: string;
  perTestTimeoutMs?: number;
  concurrency?: number;
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

/** Partial top-level config as read from a file. */
export interface GlubeanConfigInput {
  run?: GlubeanRunConfigInput;
  redaction?: GlubeanRedactionConfigInput;
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

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Check if a filename should be treated as a package config file. */
function isPackageConfig(filePath: string): boolean {
  const name = filePath.split("/").pop() ?? "";
  return name === "package.json";
}

/**
 * Read a single config source from disk.
 *
 * If the file is a package.json, extract the "glubean" field.
 * Otherwise treat the entire file as a glubean config object.
 */
export async function readSingleConfig(
  filePath: string,
): Promise<GlubeanConfigInput> {
  const content = await readFile(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();
  const parsed = (ext === ".yaml" || ext === ".yml")
    ? parseYaml(content)
    : JSON.parse(content);

  if (isPackageConfig(filePath)) {
    return (parsed.glubean as GlubeanConfigInput) ?? {};
  }
  return parsed as GlubeanConfigInput;
}

/**
 * Merge two config inputs. Later (overlay) values take precedence.
 *
 * - Scalar fields: right wins.
 * - Array fields (sensitiveKeys.additional, sensitiveKeys.excluded,
 *   patterns.custom): concatenated (additive by nature).
 */
export function mergeConfigInputs(
  base: GlubeanConfigInput,
  overlay: GlubeanConfigInput,
): GlubeanConfigInput {
  const merged: GlubeanConfigInput = {};

  // ── Run section (shallow merge, scalars override) ──────────────────────
  if (base.run || overlay.run) {
    merged.run = { ...base.run, ...overlay.run };
  }

  // ── Redaction section ──────────────────────────────────────────────────
  if (base.redaction || overlay.redaction) {
    const br = base.redaction ?? {};
    const or = overlay.redaction ?? {};

    merged.redaction = {};

    if (or.replacementFormat !== undefined) {
      merged.redaction.replacementFormat = or.replacementFormat;
    } else if (br.replacementFormat !== undefined) {
      merged.redaction.replacementFormat = br.replacementFormat;
    }

    if (br.sensitiveKeys || or.sensitiveKeys) {
      merged.redaction.sensitiveKeys = [
        ...(br.sensitiveKeys ?? []),
        ...(or.sensitiveKeys ?? []),
      ];
    }

    if (br.customPatterns || or.customPatterns) {
      merged.redaction.customPatterns = [
        ...(br.customPatterns ?? []),
        ...(or.customPatterns ?? []),
      ];
    }
  }

  // ── Cloud section (shallow merge, scalars override) ─────────────────────
  if (base.cloud || overlay.cloud) {
    merged.cloud = { ...base.cloud, ...overlay.cloud };
  }

  // ── Thresholds section (shallow merge, later rules win per metric key) ──
  if (base.thresholds || overlay.thresholds) {
    merged.thresholds = { ...base.thresholds, ...overlay.thresholds };
  }

  return merged;
}

/**
 * Apply a GlubeanConfigInput on top of the mandatory DEFAULT_CONFIG baseline
 * to produce a fully resolved RedactionConfig.
 */
function resolveRedactionConfig(
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
    input.replacementFormat === "labeled" ||
    input.replacementFormat === "partial"
  ) {
    merged.replacementFormat = input.replacementFormat;
  }

  return merged;
}

// ── Validation ───────────────────────────────────────────────────────────────

const KNOWN_TOP_KEYS = new Set(["run", "redaction", "cloud", "thresholds"]);
const KNOWN_RUN_KEYS = new Set(Object.keys(RUN_DEFAULTS));
const KNOWN_REDACTION_KEYS = new Set([
  "sensitiveKeys",
  "customPatterns",
  "replacementFormat",
]);
const KNOWN_CLOUD_KEYS = new Set(["projectId", "apiUrl", "token"]);

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      console.error(
        `\x1b[33mWarning: unknown config key "${path}.${key}" — typo?\x1b[0m`,
      );
    }
  }
}

function validateConfigInput(input: GlubeanConfigInput): void {
  warnUnknownKeys(input as Record<string, unknown>, KNOWN_TOP_KEYS, "glubean");
  if (input.run) {
    warnUnknownKeys(input.run as Record<string, unknown>, KNOWN_RUN_KEYS, "glubean.run");
  }
  if (input.redaction) {
    warnUnknownKeys(
      input.redaction as Record<string, unknown>,
      KNOWN_REDACTION_KEYS,
      "glubean.redaction",
    );
  }
  if (input.cloud) {
    warnUnknownKeys(
      input.cloud as Record<string, unknown>,
      KNOWN_CLOUD_KEYS,
      "glubean.cloud",
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the resolved GlubeanConfig.
 *
 * - If `configPaths` is undefined or empty: auto-read package.json in `rootDir`.
 * - If `configPaths` has entries: merge left-to-right, skip auto-read.
 */
export async function loadConfig(
  rootDir: string,
  configPaths?: string[],
): Promise<GlubeanConfig> {
  let accumulated: GlubeanConfigInput = {};

  if (configPaths && configPaths.length > 0) {
    for (const configPath of configPaths) {
      const absPath = resolve(rootDir, configPath);
      try {
        const single = await readSingleConfig(absPath);
        validateConfigInput(single);
        accumulated = mergeConfigInputs(accumulated, single);
      } catch {
        console.error(`Warning: Could not read config file: ${absPath}`);
      }
    }
  } else {
    // No --config: auto-read package.json in rootDir
    const pkgPath = resolve(rootDir, "package.json");
    try {
      const single = await readSingleConfig(pkgPath);
      validateConfigInput(single);
      accumulated = mergeConfigInputs(accumulated, single);
    } catch {
      // Not found, use defaults
    }
  }

  const resolvedRun: GlubeanRunConfig = {
    ...RUN_DEFAULTS,
    ...accumulated.run,
  };

  const resolvedRedaction = resolveRedactionConfig(accumulated.redaction);

  return {
    run: resolvedRun,
    redaction: resolvedRedaction,
    cloud: accumulated.cloud,
    thresholds: accumulated.thresholds,
  };
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
