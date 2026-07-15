/**
 * `glubean load [target]` — run performance plans (M4-c).
 *
 * Discovers `loadRunner()` exports in `.load.ts` files, runs each through the
 * closed-model orchestrator (`@glubean/runner` `runLoad`) IN A CHILD PROCESS,
 * writes each finalized `LoadArtifact` to `.glubean/<runnerId>.load.result.json`,
 * prints a per-plan summary, and exits non-zero if any plan's `summary.pass` is
 * false (a crash or a breached threshold). This is the dedicated load path —
 * separate from `glubean run` (the per-test ProjectRunner), since load's
 * execution model differs.
 *
 * Each `.load.ts` runs via `runLoadFileInSubprocess`, which spawns the
 * project-local runner harness (as `glubean run` does) so the harness and the
 * user file co-resolve one `@glubean/sdk` — no split-brain when a globally
 * installed CLI runs against a project with its own non-deduped sdk.
 */
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { stat, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import { loadProjectEnv, runLoadFileInSubprocess, type LoadProviderChoice } from "@glubean/runner";
import type { LoadArtifact } from "@glubean/sdk/load";
import { resolveEnvFileName, SensitiveActiveEnvError } from "../lib/active_env.js";
import { findProjectConfig } from "./run.js";
import type { UploadReceipt, UploadRunInput } from "../lib/upload.js";
import type { RedactionConfig } from "@glubean/redaction";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

// Mirror the run command's skip list (+ .glubean output) so a compiled `build/`
// dir isn't walked — otherwise a built `.load.js` could double-run a plan.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".glubean"]);

// Directory/glob discovery matches SOURCE `.load.ts` only (like `glubean run`'s
// `.ts`-only discovery), so a compiled `.load.js`/`.mjs` alongside it isn't run
// twice. An explicit file target still runs whatever the user named.
function isLoadSourceFile(name: string): boolean {
  return name.endsWith(".load.ts");
}

/** A filesystem-safe result filename for a runner id. */
export function loadResultFileName(runnerId: string): string {
  const safe = runnerId.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return `${safe || "load"}.load.result.json`;
}

/** One plan's run outcome. */
export interface LoadRunOutcome {
  file: string;
  runnerId: string;
  artifact: LoadArtifact;
}

/** A per-file failure (e.g. an unimportable load file). */
export interface LoadFileError {
  file: string;
  message: string;
}

/** Result of running a set of load files — completed outcomes + per-file errors. */
export interface RunLoadFilesResult {
  outcomes: LoadRunOutcome[];
  errors: LoadFileError[];
}

/** Outcome of interpreting the `--provider` / `--workers` flags (proposal §5.2). Pure +
 *  exported for unit testing — the console/exit side effects stay in `loadCommand`. */
export interface ResolvedLoadProvider {
  provider: LoadProviderChoice;
  /** Non-fatal warnings to print (e.g. a single-core machine choosing multi-core). */
  warnings: string[];
  /** A fatal input error (unknown provider / bad worker count) — the caller errors + exits. */
  error?: string;
  /** Multi-core requested on Windows (unsupported) — the caller errors + exits with a
   *  friendly "use in-process" hint. */
  windowsUnsupported?: boolean;
}

/**
 * Resolve the execution provider from the CLI flags (proposal §5.2 configuration surface):
 *  - default / `--provider in-process` → the unchanged single-process path;
 *  - `--provider multi-core` / `--provider multi-core:N` → the coordinator with N workers.
 *
 * Worker count precedence: an explicit `--workers N` wins over the inline `:N`, which wins
 * over the default `max(1, cores-1)`. `shardPlan` clamps the result again per plan (§5.2),
 * so this is only the REQUESTED count. Windows is unsupported (the multi-core provider needs
 * POSIX extra-fd inheritance) → flagged so the caller can steer the user to in-process.
 */
export function resolveLoadProviderChoice(
  providerFlag: string | undefined,
  workersFlag: number | undefined,
  env: { platform: NodeJS.Platform; cpuCount: number } = { platform: process.platform, cpuCount: cpus().length },
): ResolvedLoadProvider {
  const raw = (providerFlag ?? "in-process").trim();
  const [kind, inlineN] = raw.split(":");

  if (kind === "in-process" || kind === "") {
    if (workersFlag !== undefined) {
      return { provider: { kind: "in-process" }, warnings: ["--workers has no effect without --provider multi-core."] };
    }
    return { provider: { kind: "in-process" }, warnings: [] };
  }
  if (kind !== "multi-core") {
    return {
      provider: { kind: "in-process" },
      warnings: [],
      error: `Unknown --provider "${raw}". Use "in-process" (default) or "multi-core[:N]".`,
    };
  }

  // ── multi-core ──
  if (env.platform === "win32") {
    return { provider: { kind: "in-process" }, warnings: [], windowsUnsupported: true };
  }
  const defaultN = Math.max(1, env.cpuCount - 1);
  const parseCount = (v: number | string | undefined): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isInteger(n) && n >= 1 ? n : NaN; // NaN → invalid (surface below)
  };
  const explicit = parseCount(workersFlag);
  const inline = parseCount(inlineN);
  if (Number.isNaN(explicit) || Number.isNaN(inline)) {
    return {
      provider: { kind: "in-process" },
      warnings: [],
      error: `Invalid worker count — --workers / --provider multi-core:N must be a positive integer.`,
    };
  }
  const workerCount = explicit ?? inline ?? defaultN;
  const warnings: string[] = [];
  if (env.cpuCount < 2) {
    warnings.push(
      `This machine reports ${env.cpuCount} CPU core(s); multi-core load runs ${workerCount} worker(s) with no real parallelism here — consider --provider in-process.`,
    );
  }
  return { provider: { kind: "multi-core", workerCount }, warnings };
}

/**
 * Run each load file's plans in a CHILD PROCESS (`runLoadFileInSubprocess`) so the
 * harness and the user file co-resolve one `@glubean/sdk`, and collect the
 * artifacts. A single file's import failure (or a crash) is recorded as a per-file
 * error and the rest still run — completed artifacts are never discarded because a
 * LATER file is broken. The raw `{ vars, secrets }` flow to the child, which
 * applies the process.env fallback. Free of fs writes / process exit / printing.
 */
export async function runLoadFiles(
  files: string[],
  opts: {
    vars: Record<string, string>;
    secrets: Record<string, string>;
    /** Project root the child runs in — drives runner resolution + bare imports. */
    cwd: string;
    /** Execution provider (default in-process). `multi-core` runs the coordinator in the
     *  child, which spawns worker processes; the parent side is unchanged. */
    provider?: LoadProviderChoice;
  },
): Promise<RunLoadFilesResult> {
  const outcomes: LoadRunOutcome[] = [];
  const errors: LoadFileError[] = [];
  for (const file of files) {
    const res = await runLoadFileInSubprocess(file, {
      vars: opts.vars,
      secrets: opts.secrets,
      cwd: opts.cwd,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    });
    for (const o of res.outcomes) outcomes.push({ file, runnerId: o.runnerId, artifact: o.artifact });
    for (const e of res.errors) errors.push({ file, message: e.message });
  }
  return { outcomes, errors };
}

/** Write each outcome's artifact to `<glubeanDir>/<runnerId>.load.result.json`,
 *  disambiguating ids that sanitize to the same filename so no artifact is lost. */
export async function writeLoadResults(
  outcomes: LoadRunOutcome[],
  glubeanDir: string,
): Promise<string[]> {
  await mkdir(glubeanDir, { recursive: true });
  // Track collisions case-INSENSITIVELY: on macOS/Windows, "Checkout" and
  // "checkout" are the same directory entry, so an exact-string check would let
  // the second overwrite the first.
  const used = new Set<string>();
  const written: string[] = [];
  for (const o of outcomes) {
    let name = loadResultFileName(o.runnerId);
    if (used.has(name.toLowerCase())) {
      // Ids collapsed to the same filename — append `-N` so both survive.
      const base = name.replace(/\.load\.result\.json$/, "");
      let n = 2;
      while (used.has(`${base}-${n}.load.result.json`.toLowerCase())) n += 1;
      name = `${base}-${n}.load.result.json`;
    }
    used.add(name.toLowerCase());
    const path = resolve(glubeanDir, name);
    await writeFile(path, JSON.stringify(o.artifact, null, 2), "utf-8");
    written.push(path);
  }
  return written;
}

/** Recursively collect `.load.ts` files under a directory. */
async function walkLoadFiles(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkLoadFiles(resolve(dir, entry.name), out);
    } else if (entry.isFile() && isLoadSourceFile(entry.name)) {
      out.push(resolve(dir, entry.name));
    }
  }
}

/**
 * Thrown by `resolveManyLoadTargets` when ONE OR MORE of the given targets
 * resolves to zero `.load.ts` files (GLU-244 codex R1 P1): with several
 * targets (e.g. a `--profile` selection spanning multiple plans), a typo'd
 * `load.plans.<name>.target` must not be silently swallowed just because a
 * SIBLING target still resolves — that would let a misconfigured plan
 * silently not run while the command still exits 0.
 */
export class LoadTargetResolutionError extends Error {
  constructor(public readonly emptyTargets: string[]) {
    super(`No .load.ts files found for ${emptyTargets.map((t) => `"${t}"`).join(", ")}.`);
    this.name = "LoadTargetResolutionError";
  }
}

/**
 * Resolve MULTIPLE file/directory/glob targets (e.g. each plan in a
 * `glubean load --profile <name>` selection, GLU-244) to one deduped file
 * list, preserving each target's own resolution order and dropping
 * duplicates a later target re-discovers (a plan target that overlaps an
 * earlier one shouldn't double-run it). Throws `LoadTargetResolutionError`
 * if ANY individual target resolves to zero files — every selected target
 * must contribute at least one file. Exported for unit testing.
 */
export async function resolveManyLoadTargets(targets: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const empty: string[] = [];
  for (const target of targets) {
    const files = await resolveLoadFiles(target);
    if (files.length === 0) empty.push(target);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  if (empty.length > 0) throw new LoadTargetResolutionError(empty);
  return out;
}

/** Resolve a file / directory / glob target to a sorted, deduped `.load.ts` list. */
async function resolveLoadFiles(target: string): Promise<string[]> {
  const abs = resolve(target);
  try {
    const s = await stat(abs);
    if (s.isFile()) return [abs];
    if (s.isDirectory()) {
      const files: string[] = [];
      await walkLoadFiles(abs, files);
      files.sort();
      return files;
    }
  } catch {
    // not a path — try glob below
  }
  const files: string[] = [];
  for await (const entry of glob(target, { cwd: process.cwd() })) {
    const full = resolve(process.cwd(), entry);
    if (!isLoadSourceFile(full)) continue;
    const s = await stat(full).catch(() => null);
    if (s?.isFile()) files.push(full);
  }
  files.sort();
  return [...new Set(files)];
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/** Unit suffix for a quantile-interval display. Latency scopes are always ms; a
 *  `customMetric` gate's interval is in the trend's DECLARED unit (`trend({ unit:
 *  "bytes" })` folds byte values — labelling them "ms" would misreport them), resolved
 *  from the artifact's own folded metrics: an exact metricId match wins, else the
 *  longest `${metricId}:` prefix (the `metricId:tag=val` target form — same
 *  disambiguation the evaluator uses). No declared unit → no suffix (such a trend is
 *  gated in bare numbers of its own unit). */
function intervalUnit(
  t: LoadArtifact["summary"]["thresholds"][number],
  customMetrics: LoadArtifact["summary"]["customMetrics"],
): string {
  if (t.scope !== "customMetric") return "ms";
  const target = t.target ?? "";
  let best: { id: string; unit?: string } | undefined;
  for (const m of customMetrics ?? []) {
    if (m.metricId === target) return m.unit ?? "";
    if (target.startsWith(`${m.metricId}:`) && (best === undefined || m.metricId.length > best.id.length)) {
      best = { id: m.metricId, ...(m.unit !== undefined ? { unit: m.unit } : {}) };
    }
  }
  return best?.unit ?? "";
}

/** Print a one-plan summary line block. The top `iterations` line is the
 *  end-to-end (whole-transaction) view; when a scenario calls
 *  `ctx.report.primaryComplete()` the artifact also carries a primary/end-to-end
 *  phase split, surfaced as an extra line so an async-job run shows submit latency
 *  vs full latency. (Exported for display tests.) */
export function printOutcome(o: LoadRunOutcome): void {
  const s = o.artifact.summary;
  const verdict = s.pass
    ? `${colors.green}PASS${colors.reset}`
    : `${colors.red}FAIL${colors.reset}`;
  console.log(`${colors.bold}${o.runnerId}${colors.reset}  ${verdict}`);
  // Abnormal end reason (schema v2, §7.4): a run ending by duration/iterations
  // is the normal case and prints nothing; abort/crash get a line (pass is
  // already false for both — §7.4's necessary conditions). Absent endReason on
  // a pre-v2 artifact also prints nothing (unknowable).
  if (s.endReason === "abort") {
    console.log(
      `${colors.yellow}  ⚠ run aborted before completing (endReason: abort) — pass requires a` +
        ` duration/iterations end${colors.reset}`,
    );
  } else if (s.endReason === "crash") {
    const crash = o.artifact.runtime.crash;
    console.log(
      `${colors.red}  ✗ run crashed (endReason: crash)${crash ? ` — ${crash.kind}: ${crash.message}` : ""}${colors.reset}`,
    );
  }
  // Data completeness (schema v2, §7.4). Single-machine runs are always
  // "complete" (and pre-v2 artifacts carry no field — same semantics), so this
  // prints NOTHING on the normal path; "partial"/"failed" are D1 coordinator
  // judgments and get a prominent line — partial numbers are informational
  // only, never a verdict basis.
  if (s.executionStatus === "partial") {
    console.log(
      `${colors.yellow}  ⚠ PARTIAL DATA — ≥1 worker was lost before its final snapshot;` +
        ` the numbers below are informational only (no pass verdict)${colors.reset}`,
    );
    const cov = o.artifact.runtime.execution?.coverage;
    if (cov) {
      const slotSec =
        cov.slotSecondsExpected !== undefined
          ? `${cov.slotSecondsAchieved.toFixed(1)}/${cov.slotSecondsExpected.toFixed(1)}s`
          : `${cov.slotSecondsAchieved.toFixed(1)}s`;
      // An absent iterationsCompleted is UNKNOWN, not zero — rendering `0/N`
      // would falsely report "nothing completed" on a run that merely lost the
      // counter (same ratio form as the adjacent workers/slot-seconds items).
      const iters =
        cov.iterationsExpected !== undefined
          ? `  iterations ${cov.iterationsCompleted ?? "unknown"}/${cov.iterationsExpected}`
          : "";
      console.log(
        `${colors.yellow}    coverage: workers ${cov.workersFinal}/${cov.workersExpected} final` +
          `  slot-seconds ${slotSec}${iters}${colors.reset}`,
      );
    }
  } else if (s.executionStatus === "failed") {
    console.log(
      `${colors.red}  ✗ EXECUTION FAILED — no usable merged result (post-start);` +
        ` the run produced no trustworthy data${colors.reset}`,
    );
    // A failed run's aggregate fields are placeholders, not measurements —
    // printing iterations/latency/thresholds under the error line would imply
    // they mean something. Stop here.
    return;
  }
  // Multi-core provenance (schema v2, §11): show how many workers ran + any clamp note so
  // a sharded run is visibly distinct from a single-process one (single-machine runs carry
  // no execution block / an `in-process` one → this prints nothing).
  const exec = o.artifact.runtime?.execution;
  if (exec && exec.provider === "multi-core") {
    console.log(`${colors.dim}  multi-core: ${exec.workerCount} worker(s)${colors.reset}`);
    for (const note of exec.notes ?? []) {
      if (note.startsWith("worker count clamped")) {
        console.log(`${colors.yellow}  ⚠ ${note}${colors.reset}`);
      }
    }
  }
  console.log(
    `${colors.dim}  iterations ${s.totalIterations} (ok ${s.successfulIterations}, failed ${s.failedIterations})` +
      `  errorRate ${pct(s.errorRate)}  p95 ${Math.round(s.latency.p95)}ms` +
      `  throughput ${s.throughputPerSec.toFixed(1)}/s${colors.reset}`,
  );
  // Phase split (M5): the line above is end-to-end; show the primary phase (up to
  // the primaryComplete boundary). `completed/started` indicates primary coverage —
  // when fewer iterations complete primary than started, some failed before the
  // boundary (a branch/error path); precise boundary coverage lands with M6.
  if (s.primary) {
    console.log(
      `${colors.dim}  primary (to boundary)  p95 ${Math.round(s.primary.latency.p95)}ms` +
        `  throughput ${s.primary.throughputPerSec.toFixed(1)}/s` +
        `  completed ${s.primary.completed}/${s.primary.started}${colors.reset}`,
    );
    if (s.primary.completed < s.primary.started) {
      console.log(
        `${colors.yellow}  ⚠ ${s.primary.started - s.primary.completed} iteration(s) did not reach the primary boundary` +
          ` (failed before it, or a branch skipped it)${colors.reset}`,
      );
    }
  }
  // Continuation / producer-release subsystem (M6): present once any iteration engaged
  // release (released / rejected / duplicate / still pending). Show the slot model, how
  // many slots were released, the backlog peak + back-pressure, then surface rejections,
  // drain-timeout aborts, and coverage gaps as warnings.
  const c = s.continuation;
  if (c) {
    console.log(
      `${colors.dim}  continuation (${o.artifact.runtime.slotModel})  released ${c.releasedProducerSlots}` +
        `  backlog max ${c.maxBacklog}` +
        (c.backpressureMs ? `  backpressure p95 ${Math.round(c.backpressureMs.p95)}ms` : "") +
        `${colors.reset}`,
    );
    if (c.rejectedReleaseSignals > 0) {
      console.log(
        `${colors.yellow}  ⚠ ${c.rejectedReleaseSignals} release(s) rejected (backlog full, drain bound, or run deadline)${colors.reset}`,
      );
    }
    if (c.abortedByDrainTimeout > 0) {
      console.log(
        `${colors.yellow}  ⚠ ${c.abortedByDrainTimeout} continuation(s) aborted by the drain timeout` +
          ` (still in flight at finalize)${colors.reset}`,
      );
    }
    if (c.duplicateReleaseSignals > 0) {
      console.log(
        `${colors.yellow}  ⚠ ${c.duplicateReleaseSignals} duplicate release signal(s)` +
          ` (one producer-release boundary per iteration)${colors.reset}`,
      );
    }
    // Coverage gaps: only SOME iterations reached a primary boundary (a branch/error path
    // skipped it), so the producer-release stats above reflect just that subset — warn,
    // since `releaseCoverage` alone can read 100% while boundary coverage is partial.
    if (c.primaryBoundaryCoverage < 1) {
      console.log(
        `${colors.yellow}  ⚠ only ${pct(c.primaryBoundaryCoverage)} of iterations reached a primary boundary` +
          ` — producer-release stats cover that subset${colors.reset}`,
      );
    }
    if (c.releaseCoverage < 1) {
      console.log(
        `${colors.dim}  release coverage ${pct(c.releaseCoverage)} of primary boundaries${colors.reset}`,
      );
    }
  }
  for (const t of s.thresholds) {
    const where = t.target ? `${t.scope}[${t.target}]` : t.scope;
    // Tri-state (schema v2): an `unevaluable` gate is not an ordinary breach — its data
    // couldn't decide the verdict (`pass` is still false, so the run fails conservatively).
    // Show the reason (+ the quantile interval when the straddle is what blocked it)
    // instead of a plain ✗. Old artifacts carry no `status` → read as evaluated.
    if (t.status === "unevaluable") {
      const bounds = t.quantileBounds
        ? ` interval [${t.quantileBounds.lower.toFixed(1)}, ${t.quantileBounds.upper.toFixed(1)}]${intervalUnit(t, s.customMetrics)}`
        : "";
      console.log(
        `${colors.yellow}  ? ${where}.${t.metric} ${t.expression} unevaluable (${t.reason ?? "unknown"})${bounds}${colors.reset}`,
      );
      continue;
    }
    const mark = t.pass ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`${colors.dim}  ${mark} ${where}.${t.metric} ${t.expression} (actual ${t.actual})${colors.reset}`);
  }
  // Non-fatal run-shape advisories (M6-d), e.g. a long tail poll that held the producer
  // slot with no release.
  for (const a of s.advisories ?? []) {
    console.log(`${colors.yellow}  ⓘ ${a}${colors.reset}`);
  }
}

/** Options for the `load` command. */
export interface LoadCommandOptions {
  /** Env file basename (default: the active env, else `.env`). */
  envFile?: string;
  /** Upload each plan's LoadArtifact to Glubean Cloud under a target (ADR 0007). */
  upload?: boolean;
  /** Write the upload receipt(s) JSON to this path (array — one per plan). */
  uploadReceiptJson?: string;
  /** Cloud project id (or GLUBEAN_PROJECT_ID). */
  project?: string;
  /** Upload target id (or GLUBEAN_TARGET_ID; else the project's default target). */
  target?: string;
  /** Auth token (or GLUBEAN_TOKEN). */
  token?: string;
  apiUrl?: string;
  /** Profile-driven (GLU-244): read the upload token EXCLUSIVELY from this env
   *  var (after an explicit `--token`) — mirrors `run`'s per-profile
   *  `upload.tokenEnv`. No silent fallback to GLUBEAN_TOKEN when set. */
  tokenEnv?: string;
  /**
   * Profile-driven (GLU-244): the EXACT glubean.yaml path already loaded to
   * resolve the profile/plan (absolute, or relative to `rootDir`) — reused by
   * `resolveLoadUploadContext`'s own config reload (redaction resolution) so
   * a `--config <path>` override can't silently disagree between plan
   * resolution and upload redaction. Omit to use the default
   * `rootDir/glubean.yaml` path (bare `glubean load`, no --profile).
   */
  configPath?: string;
  /** Execution provider (proposal §5): `in-process` (default) or `multi-core[:N]`. */
  provider?: string;
  /** Worker count for `--provider multi-core` (overrides the inline `:N`; default
   *  `max(1, cores-1)`). */
  workers?: number;
}

/**
 * Upload each completed load plan as its own `kind: "load"` run under the target.
 * Best-effort: auth/target resolution failures print a clear error and return
 * (the local results are already written). The LoadArtifact is deep-redacted
 * (samples can carry secrets in failure traces) before it becomes the run blob.
 */
/** Resolved upload destination + redaction — validated BEFORE plans run (no
 *  false-green, no expensive load traffic against a misconfigured upload, and no
 *  upload with weaker-than-declared redaction). */
interface LoadUploadContext {
  token: string;
  projectId: string;
  apiUrl: string;
  targetId: string;
  /** Resolved redaction config (project `defaults.redaction` ∪ baseline). */
  redaction: RedactionConfig;
}

/**
 * Preflight the upload destination BEFORE running any load plan: resolve +
 * validate token / project / target. On any failure this exits non-zero so a
 * `--upload` typo fails fast instead of after a full (expensive) load run.
 * Token format isn't pre-judged locally — the server validates it (a non-glb_
 * token gets a 401 on the POST, surfaced as a failed receipt → non-zero exit).
 */
async function resolveLoadUploadContext(
  rootDir: string,
  envFileVars: Record<string, string>,
  options: LoadCommandOptions,
): Promise<LoadUploadContext> {
  const {
    resolveToken,
    resolveProjectId,
    resolveApiUrl,
    resolveTargetId,
    resolveDefaultTargetId,
    checkUploadAuth,
    checkTargetInProject,
    PLATFORM_API_URL_UNRESOLVED_HINT,
  } = await import("../lib/auth.js");
  const { resolveRedactionConfig, loadProjectConfigV1, GlubeanConfigError } =
    await import("../lib/config.js");

  const authOpts = {
    token: options.token,
    project: options.project,
    target: options.target,
    apiUrl: options.apiUrl,
  };
  const sources = { envFileVars };
  const token = await resolveToken(authOpts, sources, options.tokenEnv);
  const projectId = await resolveProjectId(authOpts, sources);
  const apiUrl = await resolveApiUrl(authOpts, sources);

  if (!token) {
    console.error(`${colors.red}Upload failed: no auth token found.${colors.reset}`);
    if (options.tokenEnv) {
      console.error(
        `${colors.dim}This profile's upload.tokenEnv points at '${options.tokenEnv}', but it's empty/unset. Set it in .env.secrets or the environment.${colors.reset}`,
      );
    } else {
      console.error(`${colors.dim}Set GLUBEAN_TOKEN / --token (a glb_ project token), or add it to .env.secrets.${colors.reset}`);
    }
    process.exit(1);
  }
  if (!projectId) {
    console.error(`${colors.red}Upload failed: no project ID.${colors.reset}`);
    console.error(`${colors.dim}Use --project or set GLUBEAN_PROJECT_ID.${colors.reset}`);
    process.exit(1);
  }
  if (!apiUrl) {
    console.error(`${colors.red}Upload failed: could not determine the Platform API URL.${colors.reset}`);
    console.error(`${colors.dim}${PLATFORM_API_URL_UNRESOLVED_HINT}${colors.reset}`);
    process.exit(1);
  }

  // Validate auth/project FIRST (before the targets-read fallback) so an invalid
  // token / mistyped project / unreachable server reports its real diagnostic
  // instead of a misleading "could not resolve a target". 403 (least-privilege)
  // proceeds; 401/404/5xx/unreachable is fatal BEFORE any load traffic.
  const check = await checkUploadAuth(apiUrl, projectId, token);
  if (!check.proceed) {
    if (check.status === 401) {
      console.error(`${colors.red}Upload failed: authentication failed (401).${colors.reset}`);
      console.error(
        `${colors.dim}The token is invalid/expired or not a platform project token (glb_…). Create one in the dashboard (Project → Tokens).${colors.reset}`,
      );
    } else if (check.status === 404) {
      console.error(`${colors.red}Upload failed: project ${projectId} not found (404).${colors.reset}`);
      console.error(
        `${colors.dim}Preflight GET: ${apiUrl}/v1/projects/${projectId}${colors.reset}`,
      );
      console.error(
        `${colors.dim}Check --project / GLUBEAN_PROJECT_ID, that --api-url / GLUBEAN_PLATFORM_API_URL / GLUBEAN_API_URL has no stray trailing slash, and that it points at the platform ingest API (the token-only \`/v1/*\` service) — not a dashboard/session-auth host, which has no \`/v1\` routes and 404s here too.${colors.reset}`,
      );
    } else if (check.status === 403) {
      console.error(`${colors.red}Upload failed: access to project ${projectId} is forbidden (403).${colors.reset}`);
      console.error(
        `${colors.dim}The token's org has no access to this project (or its membership was revoked).${colors.reset}`,
      );
    } else if (check.status === 0) {
      console.error(`${colors.red}Upload failed: cannot reach server at ${apiUrl}.${colors.reset}`);
    } else {
      console.error(`${colors.red}Upload failed: unexpected preflight response (${check.status}).${colors.reset}`);
      console.error(
        `${colors.dim}Check that --api-url / GLUBEAN_PLATFORM_API_URL / GLUBEAN_API_URL points at the Glubean platform API.${colors.reset}`,
      );
    }
    process.exit(1);
  }

  let targetId = await resolveTargetId(authOpts, sources);
  if (targetId) {
    // EXPLICIT target — validate it belongs to the project (a typo would
    // otherwise 404 only on the POST, after the load plans ran).
    const tcheck = await checkTargetInProject(apiUrl, projectId, targetId, token);
    if (!tcheck.proceed) {
      if (tcheck.status === 404) {
        console.error(
          `${colors.red}Upload failed: target ${targetId} not found in project ${projectId} (404).${colors.reset}`,
        );
        console.error(
          `${colors.dim}Preflight GET: ${apiUrl}/v1/projects/${projectId}/targets/${targetId}${colors.reset}`,
        );
        console.error(
          `${colors.dim}Check GLUBEAN_TARGET_ID / --upload-target, and that --api-url / GLUBEAN_PLATFORM_API_URL / GLUBEAN_API_URL points at the platform ingest API.${colors.reset}`,
        );
      } else if (tcheck.status === 401) {
        console.error(`${colors.red}Upload failed: authentication failed validating the target (401).${colors.reset}`);
      } else if (tcheck.status === 0) {
        console.error(`${colors.red}Upload failed: cannot reach server at ${apiUrl}.${colors.reset}`);
      } else {
        console.error(`${colors.red}Upload failed: could not validate target ${targetId} (${tcheck.status}).${colors.reset}`);
      }
      process.exit(1);
    }
    // 403 insufficient_scope (unverified) → no targets:read; can't validate, proceed.
  } else {
    targetId = await resolveDefaultTargetId(apiUrl, projectId, token);
    if (!targetId) {
      console.error(
        `${colors.red}Upload failed: could not resolve a target for project ${projectId}.${colors.reset}`,
      );
      console.error(
        `${colors.dim}Set the target explicitly (GLUBEAN_TARGET_ID or --upload-target). Auto-resolving a non-default project's target needs a token with the targets:read scope.${colors.reset}`,
      );
      process.exit(1);
    }
  }

  // Resolve redaction up front and FAIL CLOSED: a present-but-invalid glubean.yaml
  // is fatal for upload — load artifacts (samples / failure traces) can carry
  // secrets only the project's custom `defaults.redaction` rules cover, so we must
  // never silently fall back to weaker baseline-only redaction. Absent glubean.yaml
  // → baseline is correct (no custom rules declared) — but ONLY when no config
  // path was ever explicitly requested. A caller-supplied `options.configPath`
  // (GLU-244: bare `--config <path>` or the path a `--profile` resolution
  // already loaded) that turns out missing is a real error (typo'd/deleted
  // file) — codex GLU-244 R5 P2: silently falling back to baseline for an
  // EXPLICIT-but-missing config is a fail-OPEN upload, not fail-closed.
  let redaction = resolveRedactionConfig();
  try {
    // GLU-244: reuse the EXACT config path a `--profile` resolution already
    // loaded (when given) instead of always re-reading the default
    // `rootDir/glubean.yaml` — otherwise a `--config <path>` override would
    // resolve the plan from one file but redaction from another.
    const { config } = await loadProjectConfigV1(
      rootDir,
      options.configPath ? { configPath: options.configPath } : {},
    );
    redaction = resolveRedactionConfig(config.defaults?.redaction);
  } catch (err) {
    if (!(err instanceof GlubeanConfigError)) throw err;
    // "not found" is only a benign fallback-to-baseline case for the
    // DEFAULT path (no glubean.yaml at all is a valid, config-less project).
    // An EXPLICIT `--config` path that doesn't exist is always fatal.
    const isDefaultPathNotFound = !options.configPath && /not found/i.test(err.message);
    if (!isDefaultPathNotFound) {
      console.error(
        `${colors.red}Upload failed: could not load glubean.yaml redaction config (${err.message.split("\n")[0]}).${colors.reset}`,
      );
      console.error(
        `${colors.dim}Fix glubean.yaml before --upload — load artifacts must not be uploaded with weaker baseline-only redaction.${colors.reset}`,
      );
      process.exit(1);
    }
  }

  return { token, projectId, apiUrl, targetId, redaction };
}

async function uploadLoadOutcomes(
  outcomes: LoadRunOutcome[],
  ctx: {
    context: LoadUploadContext;
    rootDir: string;
    envFile: string;
    options: LoadCommandOptions;
  },
): Promise<void> {
  const { options } = ctx;
  // Destination + redaction were resolved + validated in the preflight (before
  // plans ran) — fail-fast and fail-closed; reuse them here.
  const { token, projectId, apiUrl, targetId, redaction } = ctx.context;
  const { uploadToCloud } = await import("../lib/upload.js");
  const { redactValue } = await import("@glubean/redaction");

  const receipts: UploadReceipt[] = [];
  for (const o of outcomes) {
    const a = o.artifact;
    const redactedResult = redactValue(a, {
      globalRules: redaction.globalRules,
      replacementFormat: redaction.replacementFormat,
      maxDepth: 64,
    });
    const input: UploadRunInput = {
      kind: "load",
      schemaVersion: a.schemaVersion,
      // One idempotency id per load outcome (each loadRunner = its own run),
      // reused across the upload retry so a lost-response retry replaces it (P1).
      clientRunId: randomUUID(),
      status: a.summary.pass ? "passed" : "failed",
      startedAt: a.startedAt,
      completedAt: new Date(Date.parse(a.startedAt) + a.durationMs).toISOString(),
      durationMs: a.durationMs,
      summary: {
        throughputPerSec: a.summary.throughputPerSec,
        errorRate: a.summary.errorRate,
      },
      result: redactedResult,
    };
    const receipt = await uploadToCloud(input, {
      apiUrl,
      token,
      projectId,
      targetId,
      envFile: ctx.envFile,
      rootDir: ctx.rootDir,
      // The LoadArtifact is the result blob; don't attach .glubean test artifacts.
      skipArtifacts: true,
    });
    receipts.push(receipt);
  }

  if (options.uploadReceiptJson) {
    const receiptPath = resolve(process.cwd(), options.uploadReceiptJson);
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipts, null, 2) + "\n", "utf-8");
    console.log(`${colors.dim}Upload receipt(s) written to: ${receiptPath}${colors.reset}`);
  }

  // A requested --upload where a plan's run POST was rejected is a failure, even
  // on passing load runs — exit non-zero so CI doesn't read false-green. The
  // receipts are written above first, so the failure is still recorded.
  const failedUploads = receipts.filter((r) => r.resultUpload.status === "failed").length;
  if (failedUploads > 0) {
    console.error(
      `${colors.red}Upload failed: ${failedUploads} of ${receipts.length} load run(s) were not recorded in Cloud (see errors above).${colors.reset}`,
    );
    process.exit(1);
  }
}

/**
 * `glubean load [target]` — discover + run load plans under `target` (a file,
 * directory, or glob; defaults to the cwd), write results, and exit non-zero if
 * any plan fails.
 *
 * `target` also accepts an array (GLU-244: `glubean load --profile <name>`
 * resolves a profile's `load.plans` to one target per named plan) — each is
 * resolved independently (file/dir/glob) and the results are deduped in
 * declaration order, so overlapping plan targets don't double-run a file.
 */
export async function loadCommand(
  target: string | string[] | undefined,
  options: LoadCommandOptions = {},
): Promise<void> {
  console.log(`\n${colors.bold}${colors.blue}⚡ Glubean Load${colors.reset}\n`);

  // --upload-receipt-json without --upload would silently write nothing — reject
  // the combo up front (mirrors `glubean run`).
  if (options.uploadReceiptJson && !options.upload) {
    console.error(
      `${colors.red}Error: --upload-receipt-json requires --upload.${colors.reset}`,
    );
    process.exit(1);
  }

  const targets = target === undefined ? undefined : Array.isArray(target) ? target : [target];
  let files: string[];
  if (targets) {
    try {
      files = await resolveManyLoadTargets(targets);
    } catch (err) {
      if (err instanceof LoadTargetResolutionError) {
        console.log(`${colors.yellow}${err.message}${colors.reset}`);
        process.exit(1);
      }
      throw err;
    }
  } else {
    files = await resolveLoadFiles(process.cwd());
  }
  // Defensive fallback only — every real caller supplies ≥1 target (a bare
  // `glubean load` uses `process.cwd()`; `--profile` mode's target list is
  // non-empty per `resolveLoadPlan`'s own guard), and `resolveManyLoadTargets`
  // already throws above when a NON-EMPTY target list yields zero files.
  if (files.length === 0) {
    console.log(
      `${colors.yellow}No .load.ts files found in ${process.cwd()}.${colors.reset}`,
    );
    process.exit(1);
  }

  // Derive the project root from the discovered file (not the shell cwd) so a
  // targeted run outside cwd uses the load file's project for runner resolution /
  // env / `.glubean` output.
  const { rootDir } = await findProjectConfig(dirname(files[0]));

  // An EXPLICIT --env-file that's missing is an error (mirrors `glubean run`) —
  // silently running with empty env could send load to the wrong target / run
  // without credentials. Validate the env file up front so a missing one fails
  // fast. A resolved default/active env file may be absent.
  // GLU-88: resolveEnvFileName throws SensitiveActiveEnvError instead of
  // silently returning a prod-like active-env file — surface it as a clear,
  // actionable error (mirrors `glubean run`).
  const userSpecifiedEnvFile = options.envFile !== undefined;
  let envFileName: string;
  if (userSpecifiedEnvFile) {
    envFileName = options.envFile!;
  } else {
    try {
      envFileName = await resolveEnvFileName(rootDir);
    } catch (err) {
      if (err instanceof SensitiveActiveEnvError) {
        console.log(`${colors.red}Error: ${err.message}${colors.reset}`);
        process.exit(1);
      }
      throw err;
    }
  }
  if (userSpecifiedEnvFile && !existsSync(resolve(rootDir, envFileName))) {
    console.log(`${colors.red}Error: env file '${envFileName}' not found in ${rootDir}${colors.reset}`);
    process.exit(1);
  }

  // Resolve the execution provider (default in-process; multi-core spawns worker
  // processes, proposal §5.2). Fail fast on a bad flag / Windows before any load traffic.
  const resolvedProvider = resolveLoadProviderChoice(options.provider, options.workers);
  if (resolvedProvider.error) {
    console.log(`${colors.red}Error: ${resolvedProvider.error}${colors.reset}`);
    process.exit(1);
  }
  if (resolvedProvider.windowsUnsupported) {
    console.log(
      `${colors.red}Error: multi-core load is not supported on Windows yet — the coordinator's dedicated` +
        ` control channel relies on POSIX extra-fd inheritance. Use --provider in-process on Windows.${colors.reset}`,
    );
    process.exit(1);
  }
  for (const w of resolvedProvider.warnings) {
    console.log(`${colors.yellow}⚠ ${w}${colors.reset}`);
  }
  if (resolvedProvider.provider.kind === "multi-core") {
    console.log(
      `${colors.dim}Provider: multi-core (${resolvedProvider.provider.workerCount} worker(s) requested; clamped per plan).${colors.reset}`,
    );
  }

  // Plugin bootstrap happens INSIDE each subprocess (the harness registers
  // matchers / protocol adapters before importing the load file), so the CLI no
  // longer bootstraps here.
  const { vars, secrets } = await loadProjectEnv(rootDir, envFileName);

  // Preflight the upload destination BEFORE running plans — a `--upload` typo
  // (bad token/project/target) shouldn't first generate a full load run against
  // real services and only then fail. Exits non-zero on any resolution failure.
  let uploadContext: LoadUploadContext | undefined;
  if (options.upload) {
    uploadContext = await resolveLoadUploadContext(rootDir, { ...vars, ...secrets }, options);
  }

  // A single file's import failure (or crash) is collected (not thrown) so
  // earlier/later files still produce + persist results. Pass the raw resolved
  // env — the child re-applies the process.env fallback (a Proxy can't cross the
  // process boundary), so shell/CI-supplied vars/secrets still resolve.
  const { outcomes, errors } = await runLoadFiles(files, {
    vars,
    secrets,
    cwd: rootDir,
    provider: resolvedProvider.provider,
  });

  // Persist every completed artifact FIRST — a later broken file must not discard
  // an expensive successful plan's result.
  const written = await writeLoadResults(outcomes, resolve(rootDir, ".glubean"));

  console.log();
  let anyFail = false;
  for (const o of outcomes) {
    printOutcome(o);
    if (!o.artifact.summary.pass) anyFail = true;
  }
  for (const e of errors) {
    console.log(`${colors.red}✗ ${e.message}${colors.reset}`);
  }
  if (written.length > 0) {
    console.log(`\n${colors.dim}Wrote ${written.length} result file(s) to .glubean/${colors.reset}`);
  }
  if (outcomes.length === 0 && errors.length === 0) {
    console.log(
      `${colors.yellow}No loadRunner() exports found in ${files.length} file(s).${colors.reset}`,
    );
  }

  // Upload completed plans (destination preflighted above). Runs upload
  // regardless of pass/fail — a failed load run is still worth a durable
  // performance-history record.
  if (uploadContext && outcomes.length > 0) {
    await uploadLoadOutcomes(outcomes, {
      context: uploadContext,
      rootDir,
      envFile: envFileName,
      options,
    });
  }

  // Fail if any plan failed, any file errored, or nothing ran at all.
  if (anyFail || errors.length > 0 || outcomes.length === 0) process.exit(1);
}
