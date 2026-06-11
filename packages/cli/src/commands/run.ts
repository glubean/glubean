import {
  bootstrap,
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
import { CONFIG_DEFAULTS, mergeRunOptions, toSharedRunConfig } from "../lib/config.js";
import { loadProjectEnv } from "@glubean/runner";
import { resolveEnvFileName } from "../lib/active_env.js";
import { shouldSkipTest, type CapabilityProfile } from "../lib/skip.js";
import { CLI_VERSION } from "../version.js";
import type { UploadResultPayload } from "../lib/upload.js";
import { extractContractCases, extractFromSource } from "@glubean/scanner/static";
import {
  extractContractFromFile,
  findTemplateMatch,
  loadProjectOverlays,
  matchesTemplateFilter,
} from "@glubean/scanner";
import { applyEnvTemplating } from "@glubean/runner";

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
  /** Per-test timeout ms (Phase 1 sub-task E: profile execution.timeoutMs). */
  timeoutMs?: number;
  /** Worker concurrency (Phase 1 sub-task E: profile execution.concurrency). */
  concurrency?: number;
  /**
   * Tags to EXCLUDE. Any test/case carrying ANY of these tags is dropped
   * from the inventory before execution. excludeTags is always OR-mode
   * (any match → exclude), independent of `tagMode` which only governs
   * positive `tags` matching. Phase 1 first slice — see plan §Phase 1 task 8.
   */
  excludeTags?: string[];
  envFile?: string;
  logFile?: boolean;
  pretty?: boolean;
  verbose?: boolean;
  failFast?: boolean;
  /**
   * Stop after N failures. `null` = explicit "no count limit" (e.g. from a
   * profile that disables it). Distinct from `undefined` (= "no override,
   * fall through to underlying config defaults") — mergeRunOptions
   * preserves the null vs undefined distinction.
   */
  failAfter?: number | null;
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
  uploadReceiptJson?: string;
  project?: string;
  token?: string;
  /** Env var name holding this profile's upload token (from upload.tokenEnv). */
  tokenEnv?: string;
  apiUrl?: string;
  noSession?: boolean;
  meta?: Record<string, string>;
  /**
   * Spike 3 — runner input channels (attachment-model §8).
   *
   * `inputJson` — explicit case input. Validated against the case's
   * `needs` schema; runs raw (overlay, if registered, NOT invoked).
   *
   * `bootstrapJson` — bootstrap params. Validated against the overlay's
   * `params` schema; passed to overlay's `run(ctx, params)`.
   *
   * `forceStandalone` — debug bypass for `runnability.requireAttachment`
   * on no-needs cases (§6.3 escape valve). Emits a runtime warning.
   *
   * For all three, the CLI requires `filter` to match exactly one
   * testId; the input applies to that case. `@path/to.json` form loads
   * the value from a file.
   */
  inputJson?: string;
  bootstrapJson?: string;
  forceStandalone?: boolean;
  /**
   * Per-file allow-list of runnable kinds. When set, each discovered
   * runnable is filtered: only emit it if its kind is in the file's
   * allowed set. This enforces `suite.kinds` at the RUNNABLE level —
   * a `kinds: [contract]` suite running a `.contract.ts` file that
   * also exports a flow inline still drops the flow. Missing entry
   * for a file means "no filter" (legacy behavior).
   */
  allowedKindsPerFile?: Map<string, Set<"test" | "contract" | "flow">>;
  /**
   * Full redaction config from the v1 resolved plan
   * (`defaults.redaction`). When present, runCommand uses this instead
   * of `glubeanConfig.redaction` loaded via the legacy `loadConfig`
   * path — which doesn't read glubean.yaml. Without this, projects
   * that declare custom `globalRules` / `sensitiveKeys` / `customPatterns`
   * in glubean.yaml would silently ship secrets to Cloud uploads.
   */
  redactionConfig?: import("@glubean/redaction").RedactionConfig;
  /**
   * Phase 5 5a — profile name from `glubean.yaml` the run executed
   * against. Threaded through upload payload as `metadata.runPlan.profile`
   * so cloud server can project to top-level `RunEntity.profile` for
   * index-backed `GET /open/v1/runs?profile=X` queries.
   */
  profile?: string;
  /**
   * Phase 5 5a — suite names the run spanned (in declaration order).
   * Threaded as `metadata.runPlan.suites` for the equivalent
   * `?suite=Y` membership query.
   */
  suites?: string[];
  /**
   * Metric thresholds from the v1 resolved plan (defaults.thresholds ∪
   * profile.thresholds). When non-empty, takes precedence over the legacy
   * `glubeanConfig.thresholds` (package.json) — v1 profiles can declare
   * per-profile gates that the legacy flat-shape path can't express.
   */
  thresholds?: import("@glubean/sdk").ThresholdConfig;
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

/**
 * True if a flow's extracted step tree contains a branch (condition / switch) or
 * a poll (bounded poll-until). Recurses into branch cases/default so a poll
 * nested inside a branch body is caught too.
 *
 * Used to gate `--upload`: Glubean Cloud cannot render `kind:"branch"` or
 * `kind:"poll"` flows yet, and uploading would silently drop them (local run view
 * ≠ Cloud view), so we refuse rather than mislead. See contract-flow-condition.md
 * §12 / contract-flow-poll.md §8.
 */
function flowStepsHaveBranchOrPoll(
  steps: ReadonlyArray<{ kind?: string; cases?: ReadonlyArray<{ steps?: any[] }>; default?: any[] }> | undefined,
): boolean {
  if (!steps) return false;
  for (const s of steps) {
    if (s.kind === "branch" || s.kind === "poll") return true;
    if (s.cases && s.cases.some((c) => flowStepsHaveBranchOrPoll(c.steps))) return true;
    if (s.default && flowStepsHaveBranchOrPoll(s.default)) return true;
  }
  return false;
}

/**
 * Same gate for vNext workflows (codex S2.6 R9): a workflow with `.branch()`
 * or `.poll()` nodes is a graph orchestrator Cloud cannot render yet — it gets
 * the same --upload refusal as a branch/poll flow. Recurses branch sides and
 * group children.
 */
function workflowNodesHaveBranchOrPoll(
  nodes:
    | ReadonlyArray<{
        kind: string;
        cases?: Array<{ nodes?: any[] }>;
        default?: any[];
        nodes?: any[];
      }>
    | undefined,
): boolean {
  if (!nodes) return false;
  for (const n of nodes) {
    // The whole branch FAMILY (branch/switch/route lower to kind "branch" —
    // addendum §9) and poll are graph orchestrators Cloud cannot render yet.
    if (n.kind === "branch" || n.kind === "poll") return true;
    for (const c of n.cases ?? []) {
      if (c.nodes && workflowNodesHaveBranchOrPoll(c.nodes)) return true;
    }
    if (n.default && workflowNodesHaveBranchOrPoll(n.default)) return true;
    if (n.nodes && workflowNodesHaveBranchOrPoll(n.nodes)) return true;
  }
  return false;
}

// Config consolidation (docs/06): the package.json `glubean` field is no
// longer a config source. Warn (don't error) when one lingers so users
// migrate it into glubean.yaml instead of wondering why it stopped working.
async function warnIfLegacyPackageJsonConfig(rootDir: string): Promise<void> {
  try {
    const pkg = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf-8"));
    if (pkg.glubean && typeof pkg.glubean === "object") {
      console.warn(
        `\x1b[33mWarning: the package.json \`glubean\` field is no longer read ` +
          `(config consolidation — see docs/06). Move run/redaction/thresholds ` +
          `settings into glubean.yaml; the field is currently inert.\x1b[0m`,
      );
    }
  } catch {
    // No package.json or parse error — nothing to warn about.
  }
}

const DEFAULT_SKIP_DIRS = ["node_modules", ".git", "dist", "build"];
const DEFAULT_EXTENSIONS = ["ts"];

function isGlob(target: string): boolean {
  return /[*?{[]/.test(target);
}

// Test files: anything that may CONTRIBUTE runnable tests OR overlay
// registrations during a run. `.bootstrap.ts` files don't produce
// runnables themselves, but they MUST be loaded so `contract.bootstrap()`
// calls execute and register overlays before discovery runs (attachment-
// model §7.4). `discoverTests()` is responsible for distinguishing
// bootstrap-only files from runnable-emitting ones.
const TEST_FILE_SUFFIXES = [
  ".test.ts",
  ".contract.ts",
  ".flow.ts",
  ".bootstrap.ts",
];

function isGlubeanTestFile(name: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function isBootstrapOnlyFile(name: string): boolean {
  return name.endsWith(".bootstrap.ts");
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

/**
 * Map a file path to its Glubean kind by extension.
 * - `.test.ts` → "test"
 * - `.contract.ts` → "contract"
 * - `.flow.ts` → "flow"
 * - `.bootstrap.ts` → "bootstrap" (overlay registration only; not a runnable kind)
 *
 * Returns undefined for non-Glubean files. The suite.kinds filter in
 * resolveTestFiles uses this to keep only files whose kind matches.
 */
export type GlubeanFileKind = "test" | "contract" | "flow" | "bootstrap";

export function classifyGlubeanFile(filePath: string): GlubeanFileKind | undefined {
  if (filePath.endsWith(".test.ts")) return "test";
  if (filePath.endsWith(".contract.ts")) return "contract";
  if (filePath.endsWith(".flow.ts")) return "flow";
  if (filePath.endsWith(".bootstrap.ts")) return "bootstrap";
  return undefined;
}

async function resolveSingleTarget(target: string): Promise<string[]> {
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

/**
 * Resolve one or more targets (file / dir / glob) to a deduped list of
 * test file paths. Phase 4 multi-suite execution passes a per-suite
 * array here so the runner can sweep all suites in a single pass with
 * unified discovery, filtering, and reporter output.
 */
async function resolveTestFiles(target: string | string[]): Promise<string[]> {
  const targets = Array.isArray(target) ? target : [target];
  const all: string[] = [];
  for (const t of targets) {
    const files = await resolveSingleTarget(t);
    all.push(...files);
  }
  // Dedupe (suites may share a directory) while preserving the caller-
  // supplied order. Multi-suite main.ts depends on this — sorting here
  // would mix files across suites and break failFast/failAfter
  // short-circuit ordering. resolveSingleTarget still sorts within a
  // single directory walk for determinism inside one suite.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const f of all) {
    if (seen.has(f)) continue;
    seen.add(f);
    ordered.push(f);
  }
  return ordered;
}

/**
 * Per-suite resolution helper exposed for main.ts. Resolves a suite's
 * `target` (file / dir / glob), then keeps only files whose
 * `classifyGlubeanFile` result is in `kinds` (.bootstrap.ts files are
 * always kept regardless of kinds so overlay registration still fires
 * across the project — they emit no runnable tests on their own).
 *
 * `kinds.length === 0` means "no kind filter" (all Glubean files).
 *
 * KNOWN LIMITATION (file-level only): the filter operates on the file
 * EXTENSION, not on individual exports. A `.contract.ts` file CAN
 * legitimately export a flow inline (and vice versa). For canonical
 * `tests/` + `contracts/` directory layouts this doesn't matter — each
 * file kind matches its declared suite kind. For mixed exports inside
 * a single file (`kinds: [contract]` running a flow exported from the
 * same .contract.ts), authors should split flows into `.flow.ts`. A
 * proper export-level kind filter would require threading suite kinds
 * through discoverTests and is left as a follow-up.
 */
export async function resolveTestFilesForSuite(
  target: string,
  kinds: string[],
): Promise<string[]> {
  const files = await resolveSingleTarget(target);
  if (kinds.length === 0) return files;
  const kindSet = new Set(kinds);
  // Strict per-kind file filter: `.test.ts` ↔ "test", `.contract.ts` ↔
  // "contract", `.flow.ts` ↔ "flow". This keeps the "zero files for
  // declared suite" error a reliable signal of misconfiguration.
  //
  // KNOWN LIMITATION: a `.contract.ts` file that exports ONLY a flow
  // (uncommon — flows usually live in `.flow.ts`) won't match a
  // `kinds: [flow]` suite at the file-level filter. To run such a flow
  // from a strict flow-only suite, either move the export into a
  // `.flow.ts` file (recommended canonical layout) or declare the
  // suite as `kinds: [contract, flow]` so both candidate file types
  // are scanned and the runnable-level filter sorts them out.
  //
  // The same applies to a vNext workflow authored in a `.test.ts`
  // (workflows ride the "flow" RUNNABLE kind, codex S2.6 R10/R11): a
  // strict `kinds: [flow]` suite won't see the file. Move the workflow
  // to a `.flow.ts` (recommended — it also gains the metadata
  // projection, which `.test.ts` files never get) or declare
  // `kinds: [test, flow]`; the runnable-level filter then keeps the
  // workflow and drops the plain test() exports.
  return files.filter((f) => {
    const k = classifyGlubeanFile(f);
    if (k === undefined) return false;
    // Bootstrap files: always retain so contract.bootstrap() side-effects
    // fire on import (per attachment-model §7.4 eager loading).
    if (k === "bootstrap") return true;
    return kindSet.has(k);
  });
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
  /**
   * Runnable kind — used by Phase 4's suite.kinds filter to drop
   * runnables whose kind isn't in the declared kinds for the suite
   * that contributed the file. Set by discoverTests at emit time:
   * - "test"     — plain `test(...)` exports
   * - "contract" — contract case (any protocol)
   * - "flow"     — `contract.flow(...).build()` orchestrator
   */
  kind?: "test" | "contract" | "flow";
  /**
   * Static AST flag: a vNext workflow chain in a .test.ts contains
   * `.branch(`/`.poll(`. The --upload gate reads this DIRECTLY — test files
   * are never runtime-imported, so the gate cannot re-extract them
   * (codex S2.6 R10 P2).
   */
  workflowHasBranchOrPoll?: boolean;
}

interface DiscoveredTest {
  exportName: string;
  meta: DiscoveredTestMeta;
}

export async function discoverTests(filePath: string): Promise<DiscoveredTest[]> {
  // `.bootstrap.ts` files register overlays as a side-effect of import; they
  // produce no runnable tests of their own. We don't even need to import here
  // because the project-wide `loadProjectOverlays()` ran before discovery.
  // Returning [] here keeps these files in the walker (so filtered runs
  // still evaluate them transitively) without surfacing phantom test entries.
  if (isBootstrapOnlyFile(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf-8");

  if (filePath.includes(".contract.") || filePath.includes(".flow.")) {
    // Runtime extraction via shared function (supports .with() syntax).
    // Returns BOTH contracts and flows; v0.2+ flow files often export only
    // flows, so we must emit one DiscoveredTest per flow in addition to
    // per contract case.
    const result = await extractContractFromFile(filePath);

    const results: DiscoveredTest[] = [];

    for (const ec of result.contracts) {
      const contractTags = ec.tags ?? [];
      for (const c of ec.cases) {
        // Mirror SDK dispatchContract: finalTags = contract + case + runtime
        // synthetic. Without this, pre-spawn excludeTags / --tag filtering
        // skips contract cases entirely (Phase 1 filter reads meta.tags).
        const caseTags = c.tags ?? [];
        const requires = c.requires ?? "headless";
        const defaultRun =
          c.defaultRun ?? (requires !== "headless" ? "opt-in" : "always");
        const runtimeTags: string[] = [];
        if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
        if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
        const finalTags = [...contractTags, ...caseTags, ...runtimeTags];
        results.push({
          exportName: ec.exportName,
          meta: {
            id: `${ec.id}.${c.key}`,
            // Mirror SDK dispatchContract testName: `${contractId} — ${caseKey}`.
            // Phase 1 matchesFilter checks meta.name; without this, --filter
            // matches against testId only for contract cases (uneven with test()).
            name: `${ec.id} — ${c.key}`,
            description: c.description,
            tags: finalTags.length > 0 ? finalTags : undefined,
            requires: c.requires,
            defaultRun: c.defaultRun,
            deferred: c.deferredReason,
            deprecated: c.deprecatedReason,
            kind: "contract",
          },
        });
      }
    }

    // Each flow has a single orchestrator Test (setup → steps → teardown).
    // Discover it as one runnable entry with the flow id. Post-Phase 2f
    // flows live as `kind: "flow"` entries inside `result.attachments`.
    // SDK maps FlowMeta.skip → TestMeta.deferred (string reason); mirror
    // that here so the runner's deferred-skip path applies uniformly.
    for (const att of result.attachments) {
      if (att.kind !== "flow") continue;
      results.push({
        exportName: att.exportName,
        meta: {
          id: att.flow.id,
          description: att.flow.description,
          tags: att.flow.tags,
          only: att.flow.only,
          deferred: att.flow.skip,
          kind: "flow",
        },
      });
    }

    // vNext workflows (S2.6): each BuiltWorkflow wraps the graph in ONE
    // simple test — discover it like a flow orchestrator, so a file whose
    // projection scan/upload advertises is also runnable (codex S2.6 R2 P2).
    // During the migration window workflows ride the "flow" runnable kind:
    // a workflow IS the vNext orchestrator replacing contract.flow(), and
    // suites declaring `kinds: [flow]` mean "run the graph orchestrators in
    // these files" — no new user-facing kinds enum until flow is deleted.
    // WorkflowMeta.skip → deferred mirrors the SDK's own Test wrapping.
    // workflow.pick members are THIS import's random selection — the runner
    // imports again and may select differently. Emit ONE template entry per
    // pick group; the harness's canonical template expansion (B1) resolves it
    // to the execution import's CURRENT members (codex S2.12 R6 P2). Template
    // metadata is built from GROUP-level fields: tags = the intersection
    // across members (tagFields adds row-specific tags that must not gate the
    // whole group) and `only` is preserved if ANY member carries it
    // (codex S2.12 R7 P2).
    const pickGroups = new Map<
      string,
      {
        exportName: string;
        description?: string;
        skip?: string;
        groupId?: string;
        parallel?: boolean;
        only?: boolean;
        tags?: string[];
      }
    >();
    for (const wf of result.workflows) {
      if (!wf.templateId || !wf.templateId.includes("$_pick")) continue;
      const existing = pickGroups.get(wf.templateId);
      if (!existing) {
        pickGroups.set(wf.templateId, {
          exportName: wf.exportName,
          description: wf.description,
          skip: wf.skip,
          groupId: wf.groupId,
          parallel: wf.parallel,
          only: wf.only,
          tags: wf.tags ? [...wf.tags] : undefined,
        });
      } else {
        if (wf.only) existing.only = true;
        existing.tags = existing.tags?.filter((t) => wf.tags?.includes(t));
      }
    }
    for (const [templateId, g] of pickGroups) {
      results.push({
        exportName: g.exportName,
        meta: {
          id: templateId,
          name: templateId,
          description: g.description,
          tags: g.tags && g.tags.length > 0 ? g.tags : undefined,
          only: g.only,
          deferred: g.skip,
          ...(g.groupId ? { groupId: g.groupId } : {}),
          ...(g.parallel ? { parallel: true } : {}),
          kind: "flow",
        },
      });
    }
    for (const wf of result.workflows) {
      if (wf.templateId && wf.templateId.includes("$_pick")) continue; // grouped above
      results.push({
        exportName: wf.exportName,
        meta: {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          tags: wf.tags,
          only: wf.only,
          deferred: wf.skip,
          // data-driven members: grouping + concurrency ride the projection
          // (codex S2.12 R1 P2 — the registry alone never reaches the CLI).
          ...(wf.groupId ? { groupId: wf.groupId } : {}),
          ...(wf.parallel ? { parallel: true } : {}),
          kind: "flow",
        },
      });
    }

    if (results.length > 0) return results;

    // Runtime failed — fall back to static regex ONLY for files that
    // contain ONLY contract.http(...). Stricter than MCP's gate: CLI
    // emits flows as runnable tests via discoverTests, so silently
    // dropping `contract.flow(...)` would hide an actual test. Any
    // non-HTTP usage (including flow, and a vNext workflow(...) — codex
    // S2.6 R6 P2) → fail closed and surface the import error so the user
    // knows discovery is degraded.
    if (result.errors.length > 0) {
      // Allow whitespace/newlines between `contract` and `.method` so the
      // common fluent style `contract\n  .flow(...)` still trips the gate.
      const hasHttp = /contract\s*\.\s*http\b/i.test(content);
      const hasNonHttp = /contract\s*\.\s*(?!http\b)\w+\s*[.(]/i.test(content);
      // Import-clause check catches aliased workflow imports too
      // (`import { workflow as wf }` — codex S2.6 R8 P2).
      const hasWorkflow =
        /\bworkflow\s*\(/.test(content) ||
        /import\s[^;]*?\{[^}]*\bworkflow\b[^}]*\}/.test(content);
      const contracts =
        hasHttp && !hasNonHttp && !hasWorkflow ? extractContractCases(content) : [];
      if (contracts.length > 0) {
        for (const c of contracts) {
          for (const caseItem of c.cases) {
            const requires = caseItem.requires ?? "headless";
            const defaultRun =
              caseItem.defaultRun ??
              (requires !== "headless" ? "opt-in" : "always");
            const runtimeTags: string[] = [];
            if (requires !== "headless") {
              runtimeTags.push(`requires:${requires}`);
            }
            if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
            results.push({
              exportName: c.exportName,
              meta: {
                id: `${c.contractId}.${caseItem.key}`,
                name: `${c.contractId} — ${caseItem.key}`,
                description: caseItem.description,
                tags: runtimeTags.length > 0 ? runtimeTags : undefined,
                requires: caseItem.requires,
                defaultRun: caseItem.defaultRun,
                deferred: caseItem.deferred,
                deprecated: caseItem.deprecated,
                kind: "contract",
              },
            });
          }
        }
        return results;
      }

      // Both runtime and static failed (or non-HTTP detected) — surface the
      // import error so the user knows discovery is degraded.
      for (const err of result.errors) {
        console.error(`\x1b[31m✗ Contract import failed: ${err.file}\x1b[0m`);
        console.error(`\x1b[2m  ${err.error}\x1b[0m`);
      }
    }

    return [];
  }

  const metas = extractFromSource(content);
  return metas.map((m) => {
    // Mirror the contract-case path so .test.ts authors who declare
    // `requires: "browser"` / `defaultRun: "opt-in"` see the same
    // selection behavior (excludeTags via synthetic tag-names AND
    // shouldSkipTest via meta.requires/defaultRun).
    const userTags = m.tags ?? [];
    const requires = m.requires ?? "headless";
    // Mirror SDK dispatchContract: non-headless implicitly opt-in unless
    // the author overrode defaultRun. Same default applied to test() so
    // tag-based selection (e.g. `--exclude-tag default-run:opt-in`)
    // treats equivalent test() and contract cases identically.
    const defaultRun =
      m.defaultRun ?? (requires !== "headless" ? "opt-in" : "always");
    const runtimeTags: string[] = [];
    if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
    if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
    const finalTags = [...userTags, ...runtimeTags];
    return {
      exportName: m.exportName,
      meta: {
        id: m.id,
        name: m.name,
        tags: finalTags.length > 0 ? finalTags : undefined,
        timeout: m.timeout,
        skip: m.skip,
        only: m.only,
        groupId: m.groupId ?? (m.variant === "pick" || m.parallel ? m.id : undefined),
        parallel: m.parallel,
        requires: m.requires,
        defaultRun: m.defaultRun,
        // A vNext workflow is a graph orchestrator — it rides the "flow"
        // RUNNABLE kind even when authored in a .test.ts, so the
        // runnable-level suite filter and the --upload gate treat it like a
        // flow (codex S2.6 R10 P2). NOTE: the FILE-level suite filter still
        // maps .test.ts ↔ "test" (see resolveTestFilesForSuite's KNOWN
        // LIMITATION) — a strict kinds:[flow] suite needs the workflow in a
        // .flow.ts, or kinds:[test, flow].
        kind: m.workflow ? "flow" : "test",
        ...(m.workflowHasBranchOrPoll ? { workflowHasBranchOrPoll: true } : {}),
        // WorkflowMeta.skip reason → deferred, so a skipped branch/poll
        // workflow doesn't abort --upload (codex S2.6 R13 P2).
        ...(m.deferred !== undefined ? { deferred: m.deferred } : {}),
      },
    };
  });
}

function matchesFilter(testItem: DiscoveredTest, filter: string): boolean {
  const lowerFilter = filter.toLowerCase();
  if (matchesTemplateFilter(testItem.meta.id, lowerFilter)) return true;
  if (testItem.meta.name?.toLowerCase().includes(lowerFilter)) return true;
  return false;
}

// Exported for testing only. Internal helpers otherwise.
export const __testing = {
  matchesTags: (...args: Parameters<typeof matchesTags>) => matchesTags(...args),
  matchesExcludeTags: (...args: Parameters<typeof matchesExcludeTags>) =>
    matchesExcludeTags(...args),
  flowStepsHaveBranchOrPoll: (...args: Parameters<typeof flowStepsHaveBranchOrPoll>) =>
    flowStepsHaveBranchOrPoll(...args),
  workflowNodesHaveBranchOrPoll: (...args: Parameters<typeof workflowNodesHaveBranchOrPoll>) =>
    workflowNodesHaveBranchOrPoll(...args),
};

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

/**
 * Returns true if the test carries ANY tag in excludeTags (case-insensitive).
 * Always OR-mode — independent of positive-side tagMode. A test with no
 * tags is never excluded by this filter.
 */
function matchesExcludeTags(
  testItem: DiscoveredTest,
  excludeTags: string[],
): boolean {
  if (!excludeTags.length) return false;
  if (!testItem.meta.tags?.length) return false;
  const lowerTestTags = testItem.meta.tags.map((t) => t.toLowerCase());
  return excludeTags.some((t) => lowerTestTags.includes(t.toLowerCase()));
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

function findFileTestByRuntimeId(
  tests: readonly FileTest[],
  runtimeId: string,
): FileTest | undefined {
  const match = findTemplateMatch(
    tests.map((ft) => ({ id: ft.test.meta.id, ft })),
    runtimeId,
  );
  return match?.ft;
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

async function writeEmptyResult(target: string | string[], runAt: string): Promise<void> {
  const payload = {
    target: Array.isArray(target) ? target.join(", ") : target,
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
  target: string | string[],
  options: RunOptions = {},
): Promise<void> {
  const logEntries: LogEntry[] = [];
  const runStartDate = new Date();
  const runStartTime = runStartDate.toISOString();
  const runStartLocal = localTimeString(runStartDate);

  if (options.uploadReceiptJson && !options.upload) {
    console.error(
      `${colors.red}Error: --upload-receipt-json requires --upload or an upload-enabled profile.${colors.reset}`,
    );
    process.exit(1);
  }

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
  // Single string view of target for serialization / display paths
  // (result.json, junit, traces). Multi-suite passes an array; join with
  // ", " so downstream consumers still see a printable target field.
  const targetDisplay = Array.isArray(target) ? target.join(", ") : target;

  if (testFiles.length === 0) {
    console.error(
      `\n${colors.red}❌ No test files found for target: ${
        Array.isArray(target) ? target.join(", ") : target
      }${colors.reset}`,
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
    const targetDisplay = Array.isArray(target)
      ? target.map((t) => resolve(t)).join(", ")
      : resolve(target);
    console.log(`${colors.dim}Target: ${targetDisplay}${colors.reset}`);
    console.log(
      `${colors.dim}Files:  ${testFiles.length} test file(s)${colors.reset}\n`,
    );
  } else {
    console.log(`${colors.dim}File: ${testFiles[0]}${colors.reset}\n`);
  }

  const startDir = testFiles[0].substring(0, testFiles[0].lastIndexOf("/"));
  const { rootDir } = await findProjectConfig(startDir);

  // Config consolidation (docs/06 P2): the legacy package.json `glubean`
  // flat-shape is no longer read. Profile runs get run/redaction/thresholds
  // from the resolved plan (threaded via `options`); non-profile target runs
  // fall back to built-in defaults + CLI flags + env. Warn once if a stale
  // `glubean` field lingers in package.json so users know it's inert now.
  await warnIfLegacyPackageJsonConfig(rootDir);
  const glubeanConfig = structuredClone(CONFIG_DEFAULTS);
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
    // Phase 1 sub-task E1: forward profile-driven execution settings.
    // mergeRunOptions handles undefined as "no override" — so non-profile
    // runs (where options.timeoutMs/concurrency are undefined) keep
    // legacy GlubeanRunConfig defaults; profile runs get the resolved values.
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
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
    const preToken = await resolveToken(authOpts, sources, options.tokenEnv);
    const preProject = await resolveProjectId(authOpts, sources);
    const preApiUrl = await resolveApiUrl(authOpts, sources);
    if (!preToken) {
      console.error(
        `${colors.red}Error: --upload requires authentication but no token found.${colors.reset}`,
      );
      if (options.tokenEnv) {
        console.error(
          `${colors.dim}This profile's upload.tokenEnv points at '${options.tokenEnv}', but it's empty/unset. Set it in .env.secrets or the environment.${colors.reset}`,
        );
      } else {
        console.error(
          `${colors.dim}Run 'glubean login', set GLUBEAN_TOKEN, or add token to .env.secrets or package.json glubean.cloud.${colors.reset}`,
        );
      }
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

  // ── Bootstrap plugins BEFORE discovery ─────────────────────────────────
  // CLI's `discoverTests` dynamically imports each .contract.ts / .test.ts
  // in this process. If the file uses plugin-registered names like
  // `contract.graphql.with(...)` before the plugin's manifest is installed,
  // the import throws ("Cannot read properties of undefined (reading
  // 'with')"). ProjectRunner calls bootstrap() too, but that happens AFTER
  // our discovery — too late. Matching MCP's `glubean_openapi` pattern here:
  // explicit bootstrap before any parent-process contract file import. The
  // call is idempotent (bootstrap tracks loadState internally), so
  // ProjectRunner's internal call is a no-op second visit.
  await bootstrap(rootDir);

  // ── Eager-load overlay registrations (attachment-model §7.4) ────────────
  // A filtered run (e.g. `glubean run path/to/single.contract.ts`) would
  // otherwise miss sibling `*.bootstrap.ts` overlay registrations that
  // wrap cases in the filtered-in contract. §7.4 mandates eager loading
  // before any test runs so overlay registration is deterministic.
  // Idempotent: ProjectRunner re-invokes the same helper (no-op second
  // visit thanks to mtime-keyed module cache).
  const overlayLoad = await loadProjectOverlays(rootDir);
  for (const err of overlayLoad.errors) {
    console.error(
      `${colors.yellow}⚠ Bootstrap overlay failed to load:${colors.reset} ${err.file}`,
    );
    console.error(`${colors.dim}${err.error}${colors.reset}`);
  }

  // ── Discover tests across all files ─────────────────────────────────────
  console.log(`${colors.dim}Discovering tests...${colors.reset}`);
  const allFileTests: FileTest[] = [];
  let totalDiscovered = 0;

  for (const filePath of testFiles) {
    try {
      const tests = await discoverTests(filePath);
      // Phase 4 multi-suite: enforce suite.kinds at the runnable level
      // (not just file-level). A `.contract.ts` exporting an inline
      // `contract.flow(...)` produces a flow runnable; if the contributing
      // suite declared `kinds: [contract]`, drop the flow here.
      const allowedKinds = options.allowedKindsPerFile?.get(filePath);
      const filteredTests = allowedKinds
        ? tests.filter((t) => {
            const k = t.meta.kind;
            // Treat missing kind as "always allowed" — legacy / static-
            // fallback paths populate kind, but the safety net keeps
            // unknown shapes runnable rather than silently dropped.
            return k === undefined || allowedKinds.has(k);
          })
        : tests;
      for (const test of filteredTests) {
        allFileTests.push({ filePath, exportName: test.exportName, test });
      }
      totalDiscovered += filteredTests.length;
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
  const hasExcludeTags = options.excludeTags && options.excludeTags.length > 0;
  const testsToRun = allFileTests.filter((ft) => {
    const tc = ft.test;
    if (tc.meta.skip) return false;
    if (hasOnly && !tc.meta.only) return false;
    if (options.filter && !matchesFilter(tc, options.filter)) return false;
    if (hasTags && !matchesTags(tc, options.tags!, options.tagMode)) return false;
    if (hasExcludeTags && matchesExcludeTags(tc, options.excludeTags!)) return false;
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

  // ── Gate: Cloud cannot yet render branch (condition/switch) flows ──────
  // Operate on the POST-FILTER selected runnables (`testsToRun`) so a branch
  // flow that was filtered out (--filter / tags / .only / suite kinds) does not
  // block an otherwise-branchless upload. Uploading a branch flow would
  // silently drop its branches server-side (Cloud run view ≠ local), so refuse
  // before running and name the offending flows. Bootstrap already ran, so
  // plugin-backed files re-extract from Node's cache cleanly.
  // (contract-flow-condition.md §12 / Spike 6.)
  if (options.upload) {
    // Exclude deferred (FlowMeta.skip → meta.deferred) flows: they don't
    // execute — only a skipped row is uploaded — so their branches never reach
    // Cloud and they must not block the upload.
    const selectedFlows = testsToRun.filter(
      (ft) => ft.test.meta.kind === "flow" && !ft.test.meta.deferred,
    );
    if (selectedFlows.length > 0) {
      // Map each selected flow's source file → the set of its branch/poll flow ids.
      // Only runtime-extractable files are re-imported here; a .test.ts
      // workflow carries a STATIC branch/poll flag on its discovered meta
      // instead (test files are never runtime-imported — codex S2.6 R10 P2).
      const branchIdsByFile = new Map<string, Set<string>>();
      const extractableFiles = new Set(
        selectedFlows
          .map((ft) => ft.filePath)
          // Exclude EVERY test-file suffix (.test.ts/.js/.mjs/…), not just the
          // .ts one classifyGlubeanFile knows: re-extraction imports the file,
          // and test files must never be runtime-imported (codex S2.6 R12 P2).
          // Suffix-anchored so a runtime-extractable `checkout.test.flow.ts`
          // is NOT excluded (codex R13: it classifies as flow and must be
          // re-extracted for its branch/poll nodes).
          .filter(
            (p) =>
              classifyGlubeanFile(p) !== "test" &&
              !/\.test\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(basename(p)),
          ),
      );
      for (const filePath of extractableFiles) {
        try {
          const extracted = await extractContractFromFile(filePath);
          const ids = new Set<string>();
          for (const att of extracted.attachments ?? []) {
            if (att.kind === "flow" && flowStepsHaveBranchOrPoll(att.flow.steps)) ids.add(att.flow.id);
          }
          // vNext workflows ride the "flow" runnable kind, so they reach this
          // gate too — a branch/poll workflow gets the same refusal (codex
          // S2.6 R9 P2). A pick group's discovery entry carries the TEMPLATE
          // id while runtime extraction yields concrete universe ids — gate
          // on both (codex S2.12 R8 P2).
          for (const wf of extracted.workflows ?? []) {
            if (workflowNodesHaveBranchOrPoll(wf.nodes)) {
              ids.add(wf.id);
              if (wf.templateId) ids.add(wf.templateId);
            }
          }
          branchIdsByFile.set(filePath, ids);
        } catch {
          // Real import/extraction errors are surfaced by discovery above.
        }
      }
      const branchFlows = selectedFlows.filter(
        (ft) =>
          ft.test.meta.workflowHasBranchOrPoll === true ||
          branchIdsByFile.get(ft.filePath)?.has(ft.test.meta.id),
      );
      if (branchFlows.length > 0) {
        console.error(
          `${colors.red}Error: --upload does not yet support branch (condition/switch) or poll flows.${colors.reset}`,
        );
        console.error(
          `${colors.dim}Glubean Cloud can't render these flows yet, and uploading would silently drop their branches/polls:${colors.reset}`,
        );
        for (const ft of branchFlows) {
          console.error(
            `${colors.dim}  - ${ft.test.meta.id} (${ft.exportName}) [${relative(process.cwd(), ft.filePath)}]${colors.reset}`,
          );
        }
        console.error(
          `${colors.dim}Run without --upload, or remove condition/switchOn/switchCond/poll from these flows, until Cloud support lands.${colors.reset}`,
        );
        process.exit(1);
      }
    }
  }

  console.log(
    `\n${colors.bold}Running ${testsToRun.length} test(s)...${colors.reset}\n`,
  );

  // ── Spike 3: runner input channels (attachment-model §8) ────────────────
  // `--input-json` / `--bootstrap-json` / `--force-standalone` apply to a
  // single targeted case; require --filter to resolve to exactly one test.
  // Maps are JSON-encoded `{ [testId]: <value> }` and passed to the harness
  // subprocess via env vars (which the harness reads in `setExplicitInput`
  // / `setBootstrapInput` / `setForceStandalone` calls before user import).
  const hasInputFlag =
    options.inputJson !== undefined ||
    options.bootstrapJson !== undefined ||
    options.forceStandalone === true;
  if (hasInputFlag) {
    // §5.1 invariant: explicit input always wins; overlay (and therefore
    // its bootstrap-params channel) is NOT invoked. Per the proposal's
    // "no run-bootstrap-for-side-effects-then-use-my-input mode" rule,
    // the two channels are exclusive at the surface boundary too —
    // dispatcher would silently drop the bootstrap input otherwise.
    if (
      options.inputJson !== undefined &&
      options.bootstrapJson !== undefined
    ) {
      console.error(
        `\n${colors.red}❌ --input-json and --bootstrap-json are mutually exclusive.${colors.reset}\n` +
          `${colors.dim}Per attachment-model §5.1: explicit input bypasses the overlay, so bootstrap params would be ignored. Pick one channel per run.${colors.reset}\n`,
      );
      process.exit(1);
    }
    if (testsToRun.length !== 1) {
      console.error(
        `\n${colors.red}❌ --input-json / --bootstrap-json / --force-standalone require ` +
          `--filter to match exactly one testId. Matched ${testsToRun.length} tests.${colors.reset}\n`,
      );
      if (testsToRun.length > 1) {
        const ids = testsToRun.map((t) => t.test.meta.id).slice(0, 10);
        console.error(
          `${colors.dim}First matches: ${ids.join(", ")}${ids.length < testsToRun.length ? "…" : ""}${colors.reset}`,
        );
      }
      process.exit(1);
    }
    const targetTestId = testsToRun[0]!.test.meta.id;

    async function resolveJsonFlag(
      raw: string,
      flagName: string,
    ): Promise<unknown> {
      let text: string;
      if (raw.startsWith("@")) {
        const filePath = resolve(raw.slice(1));
        try {
          text = await readFile(filePath, "utf-8");
        } catch (err) {
          console.error(
            `\n${colors.red}❌ ${flagName}: could not read ${filePath}: ` +
              `${err instanceof Error ? err.message : String(err)}${colors.reset}\n`,
          );
          process.exit(1);
        }
      } else {
        text = raw;
      }
      try {
        return JSON.parse(text);
      } catch (err) {
        console.error(
          `\n${colors.red}❌ ${flagName}: invalid JSON: ` +
            `${err instanceof Error ? err.message : String(err)}${colors.reset}\n`,
        );
        process.exit(1);
      }
    }

    // Templating env: project-loaded vars+secrets + process.env. Secrets
    // win over vars; process.env wins over both (matches `loadProjectEnv`'s
    // own precedence). §8 — substitution happens before schema validation.
    const templatingEnv: Record<string, string | undefined> = {
      ...envVars,
      ...secrets,
      ...process.env,
    };

    if (options.inputJson !== undefined) {
      const parsed = await resolveJsonFlag(options.inputJson, "--input-json");
      let templated: unknown;
      try {
        templated = applyEnvTemplating(parsed, templatingEnv);
      } catch (err) {
        console.error(
          `\n${colors.red}❌ --input-json: ${err instanceof Error ? err.message : String(err)}${colors.reset}\n`,
        );
        process.exit(1);
      }
      process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"] = JSON.stringify({
        [targetTestId]: templated,
      });
      console.log(`${colors.dim}  --input-json: ${targetTestId}${colors.reset}`);
    }
    if (options.bootstrapJson !== undefined) {
      const parsed = await resolveJsonFlag(
        options.bootstrapJson,
        "--bootstrap-json",
      );
      let templated: unknown;
      try {
        templated = applyEnvTemplating(parsed, templatingEnv);
      } catch (err) {
        console.error(
          `\n${colors.red}❌ --bootstrap-json: ${err instanceof Error ? err.message : String(err)}${colors.reset}\n`,
        );
        process.exit(1);
      }
      process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"] = JSON.stringify({
        [targetTestId]: templated,
      });
      console.log(`${colors.dim}  --bootstrap-json: ${targetTestId}${colors.reset}`);
    }
    if (options.forceStandalone === true) {
      process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"] = JSON.stringify([
        targetTestId,
      ]);
      console.warn(
        `${colors.yellow}⚠ --force-standalone enabled for ${targetTestId} (debug)${colors.reset}`,
      );
    }
  } else {
    // Clear stale state from prior runs in the same process.
    delete process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
    delete process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
    delete process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];
  }

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
  let currentTestItems: (typeof testsToRun) | undefined;
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
  // Runtime skip (ctx.skip() in setup/step/quick-mode → status: "skipped").
  // Routed to the skipped bucket, not counted as pass or fail.
  let testSkipped = false;
  let skipReason: string | undefined;
  let errorMsg: string | undefined;
  let errorStack: string | undefined;
  let errorReason: string | undefined;
  let errorMissingPath: string | undefined;
  let errorSuggestions: string[] | undefined;
  let peakMemoryMB: string | undefined;
  let stepAssertionCount = 0;
  let stepTraceLines: string[] = [];
  let testStarted = false;
  // Plan 1 AC5: dedupe warning messages per session so the same warning
  // doesn't repeat across session setup + each file's run() call.
  const emittedWarnings = new Set<string>();

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
    // A skip only counts as skipped when nothing failed before it. A failed
    // assertion is authoritative — skip must not mask it (matches the executor
    // summary and the step-path rule in the harness).
    const skippedClean = testSkipped && allAssertionsPassed;

    // The status:"skipped" event was consumed before the event loop appended it
    // to testEvents, so re-add it here. This keeps a runtime skip detectable in
    // per-test consumers (result-json, upload) and mirrors capability-skip rows,
    // whose events array also carries a status:"skipped" entry.
    if (skippedClean) {
      testEvents.push({
        type: "status",
        status: "skipped",
        ...(skipReason && { reason: skipReason }),
      } as ExecutionEvent);
    }

    collectedRuns.push({
      testId,
      testName,
      tags: testItem?.meta.tags,
      filePath: currentGroupFilePath,
      events: testEvents,
      // A cleanly-skipped test is not a failure (mirrors capability-skip rows).
      success: skippedClean ? true : finalSuccess,
      durationMs: duration,
      groupId: testItem?.meta.groupId,
    });

    addLogEntry(
      "result",
      skippedClean ? "SKIPPED" : finalSuccess ? "PASSED" : "FAILED",
      {
        duration,
        success: skippedClean ? true : finalSuccess,
        peakMemoryMB,
      },
    );

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

    if (skippedClean) {
      const reasonSuffix = skipReason ? ` — ${skipReason}` : "";
      console.log(
        `    ${colors.yellow}⊘ SKIPPED${colors.reset} ${colors.dim}(${miniStats.join(", ")})${reasonSuffix}${colors.reset}`,
      );
      skipped++;
    } else if (finalSuccess) {
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
      if (errorReason === "test_file_missing" && errorMissingPath) {
        console.log(
          `      ${colors.red}✗ Test file not found: ${errorMissingPath}${colors.reset}`,
        );
        if (errorSuggestions && errorSuggestions.length > 0) {
          console.log(`        ${colors.dim}Did you mean:${colors.reset}`);
          for (const s of errorSuggestions) {
            console.log(`          ${s}`);
          }
        }
      } else {
        console.log(`      ${colors.red}Error: ${errorMsg}${colors.reset}`);
        if (errorStack) {
          const lines = errorStack.split("\n").slice(1);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const isFramework =
              trimmed.includes("/node_modules/") ||
              trimmed.includes("/@glubean/runner/") ||
              trimmed.includes("internal/modules/");
            console.log(
              `        ${isFramework ? colors.dim : colors.reset}${trimmed}${colors.reset}`,
            );
          }
        }
      }
    }

    // Clear error fields after rendering so file:complete's orphan branch
    // (`!testStarted && errorMsg`) doesn't render this same failure again
    // and double-count it. The orphan branch is only meant for failures
    // that happened BEFORE any test started (e.g. harness died during
    // userModule load) — once we've finalized a started test, the error
    // belongs to that test alone.
    errorMsg = undefined;
    errorStack = undefined;
    errorReason = undefined;
    errorMissingPath = undefined;
    errorSuggestions = undefined;
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

  // Files that are 100% capability-skipped need ⊘ rows emitted manually
  // because ProjectRunner never starts a file with zero runnable tests
  // (file:start, which normally renders inline skip rows, won't fire).
  // We do NOT emit them up-front because that would re-order them ahead of
  // any earlier runnable files. Instead, we render them lazily — right
  // before the next runnable file's `file:start` fires (and one final pass
  // after run:complete for any trailing all-skipped files). This keeps the
  // visible file order matching `fileGroups` insertion order even in
  // multi-file fail-fast runs.
  const fileOrder = Array.from(fileGroups.keys());
  let nextFileIdx = 0;
  const emitAllSkippedFilesUpTo = (stopFilePath: string | null): void => {
    while (nextFileIdx < fileOrder.length) {
      const filePath = fileOrder[nextFileIdx];
      if (filePath === stopFilePath) return;
      nextFileIdx++;
      if (runnableByFile.has(filePath)) continue;
      const skips = fileCapabilitySkips.get(filePath);
      if (!skips || skips.length === 0) continue;
      if (isMultiFile) {
        const relPath = relative(process.cwd(), filePath);
        console.log(`${colors.bold}📁 ${relPath}${colors.reset}`);
      }
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
          filePath,
          events: [{ type: "status", status: "skipped", reason } as ExecutionEvent],
          success: true,
          durationMs: 0,
          groupId: ft.test.meta.groupId,
        });
      }
      fileCapabilitySkips.delete(filePath);
      startedFiles.add(filePath);
    }
  };

  // If every selected test was capability-skipped, ProjectRunner has
  // nothing to do. Running it anyway would still perform session setup,
  // which on a broken session.ts would mask the skip output behind a
  // session:setup:failed exit. Drain the skip rows now and short-circuit
  // to the summary block.
  const hasRunnable = runnableTests.length > 0;
  if (!hasRunnable) {
    emitAllSkippedFilesUpTo(null);
  }

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

  // Only walk the runner stream when there are runnable tests. The empty
  // case has already emitted all capability skips above and falls
  // straight through to the summary.
  for await (const ev of hasRunnable ? runner.run() : []) {
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
        } else if (se.type === "warning") {
          // Plan 1 AC5: render runner-fallback warnings emitted during
          // session setup. Only dedupe runner diagnostics (those carry a
          // `code` field — see ExecutionEvent.warning schema); user-emitted
          // ctx.warn(false, ...) warnings have no code and pass through.
          const isRunnerDiag = !!(se as { code?: string }).code;
          if (!isRunnerDiag || !emittedWarnings.has(se.message)) {
            if (isRunnerDiag) emittedWarnings.add(se.message);
            console.log(`  ${colors.yellow}⚠ ${se.message}${colors.reset}`);
          }
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
        // Flush any 100%-skipped files that come before this one in
        // fileGroups order, so the user sees them in their natural place.
        emitAllSkippedFilesUpTo(ev.filePath);
        if (
          nextFileIdx < fileOrder.length &&
          fileOrder[nextFileIdx] === ev.filePath
        ) {
          nextFileIdx++;
        }
        currentGroupFilePath = ev.filePath;
        startedFiles.add(ev.filePath);
        const runnable = runnableByFile.get(ev.filePath) ?? [];
        currentTestItems = runnable;
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
            const entry =
              currentTestMap?.get(event.id) ??
              (currentTestItems ? findFileTestByRuntimeId(currentTestItems, event.id) : undefined);
            testId = event.id;
            testName = entry?.test.meta.name || event.name || event.id;
            testItem = entry?.test || null;
            startTime = Date.now();
            testEvents = [];
            assertions = [];
            success = false;
            testSkipped = false;
            skipReason = undefined;
            errorMsg = undefined;
            errorStack = undefined;
            errorReason = undefined;
            errorMissingPath = undefined;
            errorSuggestions = undefined;
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
            testSkipped = event.status === "skipped";
            if (testSkipped) skipReason = event.reason;
            if (event.error) {
              errorMsg = event.error;
              errorStack = event.stack;
              errorReason = event.reason;
              errorMissingPath = event.missingPath;
              errorSuggestions = event.suggestions;
              addLogEntry("error", event.error);
            }
            if (event.peakMemoryMB) peakMemoryMB = event.peakMemoryMB;
            finalizeTest();
            break;

          case "error":
            success = false;
            if (!errorMsg) {
              errorMsg = event.message;
              errorStack = event.stack;
              errorReason = event.reason;
              errorMissingPath = event.missingPath;
              errorSuggestions = event.suggestions;
            }
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

          case "branch": {
            const label = event.message ? ` ${colors.dim}(${event.message})${colors.reset}` : "";
            if (event.error !== undefined) {
              console.log(
                `    ${colors.cyan}◇${colors.reset} ${colors.bold}branch${colors.reset}${label} ${colors.red}✗ ${event.error}${colors.reset}`,
              );
            } else {
              const taken = event.takenIndex === "default"
                ? "default"
                : `case ${event.takenIndex}${
                    event.takenValue !== undefined ? ` = ${JSON.stringify(event.takenValue)}` : ""
                  }`;
              console.log(
                `    ${colors.cyan}◇${colors.reset} ${colors.bold}branch${colors.reset}${label} ${colors.dim}→ ${taken}${colors.reset}`,
              );
            }
            break;
          }

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
            // Plan 1 AC5: dedupe runner-fallback / protocol-min warnings
            // (carry a `code` field — see ExecutionEvent.warning schema).
            // User-emitted ctx.warn(false, ...) warnings have no code and
            // pass through every time so test authors can see them repeat.
            const isRunnerDiag = !!event.code;
            if (!isRunnerDiag || !emittedWarnings.has(event.message)) {
              if (isRunnerDiag) emittedWarnings.add(event.message);
              console.log(
                `      ${warnIcon} ${colors.yellow}${event.message}${colors.reset}`,
              );
            }
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
          // Plan 4: rich render for orphan-error case (no leading start event,
          // e.g. harness died during userModule import).
          if (errorReason === "test_file_missing" && errorMissingPath) {
            console.log(
              `  ${colors.red}✗ Test file not found: ${errorMissingPath}${colors.reset}`,
            );
            if (errorSuggestions && errorSuggestions.length > 0) {
              console.log(`    ${colors.dim}Did you mean:${colors.reset}`);
              for (const s of errorSuggestions) {
                console.log(`      ${s}`);
              }
            }
          } else {
            console.log(
              `  ${colors.red}✗ ${errorMsg}${colors.reset}`,
            );
            if (errorStack) {
              const lines = errorStack.split("\n").slice(1);
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const isFramework =
                  trimmed.includes("/node_modules/") ||
                  trimmed.includes("/@glubean/runner/") ||
                  trimmed.includes("internal/modules/");
                console.log(
                  `    ${isFramework ? colors.dim : colors.reset}${trimmed}${colors.reset}`,
                );
              }
            }
          }
          failed++;
        }
        if (testStarted) {
          if (!errorMsg) errorMsg = "Process exited before test completed";
          finalizeTest();
        }
        break;

      case "run:complete":
        // Flush any trailing 100%-skipped files (after the last runnable
        // file). Under fail-fast, also flush only up to the file that
        // actually started — files beyond the fail point still belong to
        // the fail-fast pass below, not to the capability-skip pass.
        if (failureLimit === undefined || ev.failedCount < failureLimit) {
          emitAllSkippedFilesUpTo(null);
        }
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
  // Prefer the v1 plan's resolved thresholds when present (profile mode);
  // fall back to the legacy package.json `thresholds` otherwise. (P2 removes
  // the legacy source — see docs/06 config consolidation.)
  const effectiveThresholds =
    options.thresholds && Object.keys(options.thresholds).length > 0
      ? options.thresholds
      : glubeanConfig.thresholds;
  let thresholdSummary: import("@glubean/sdk").ThresholdSummary | undefined;
  if (effectiveThresholds && Object.keys(effectiveThresholds).length > 0) {
    thresholdSummary = evaluateThresholds(effectiveThresholds, metricCollector);
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
      `# Target: ${
        isMultiFile
          ? Array.isArray(target)
            ? target.map((t) => resolve(t)).join(", ")
            : resolve(target)
          : testFiles[0]
      }`,
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
        target: targetDisplay,
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
    target: targetDisplay,
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
    const xml = toJunitXml(collectedRuns, targetDisplay, summaryData);
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
    const token = await resolveToken(authOpts, sources, options.tokenEnv);
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
      // Prefer the v1 plan's full redaction config when supplied
      // (Phase 4 init scaffolds `defaults.redaction` in glubean.yaml,
      // including any custom globalRules / sensitiveKeys / customPatterns).
      // The legacy loadConfig path doesn't read glubean.yaml — without
      // this, custom rules would be silently ignored and matching
      // secrets could be sent to Cloud.
      const effectiveRedaction =
        options.redactionConfig ?? glubeanConfig.redaction;
      const compiledScopes = compileScopes({
        builtinScopes: BUILTIN_SCOPES,
        globalRules: effectiveRedaction.globalRules,
        replacementFormat: effectiveRedaction.replacementFormat,
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

      // Phase 5 5a — attach run-plan provenance to the upload metadata
      // bucket. Cloud server projects this to top-level RunEntity fields
      // (see apps/server/src/tasks/helpers/extract-run-plan.ts). Nested
      // under `metadata` to clear the server DTO's `forbidNonWhitelisted`
      // top-level gate. Only emitted when:
      //   1. The run used a profile (no profile → nothing to record).
      //   2. The scan path produced metadata.
      // Skipping runPlan in the degraded-scan path is intentional —
      // synthesizing a runPlan-only shell with `files: {}` would make
      // the server's upsertTests treat all active tests as "removed"
      // (authoritative file map = empty). Better to lose runPlan
      // provenance on degraded scans than to corrupt the test registry.
      if (metadata && options.profile) {
        const runPlan: { profile: string; suites?: string[] } = {
          profile: options.profile,
        };
        if (options.suites && options.suites.length > 0) {
          runPlan.suites = options.suites;
        }
        metadata = { ...metadata, runPlan };
      }

      const redactedPayload = {
        ...resultPayload,
        metadata,
        tests: resultPayload.tests.map((t) => ({
          ...t,
          events: t.events.map((e) => redactEvent(e, compiledScopes, effectiveRedaction.replacementFormat)),
        })),
      };

      const uploadReceipt = await uploadToCloud(redactedPayload, {
        apiUrl,
        token,
        projectId,
        envFile: effectiveRun.envFile,
        rootDir,
      });
      if (options.uploadReceiptJson) {
        const receiptPath = resolveOutputPath(options.uploadReceiptJson, process.cwd());
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, JSON.stringify(uploadReceipt, null, 2) + "\n", "utf-8");
        console.log(`${colors.dim}Upload receipt written to: ${receiptPath}${colors.reset}`);
      }
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
