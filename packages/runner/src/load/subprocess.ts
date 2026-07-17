/**
 * Subprocess load execution — spawn the runner's `load-harness` in a child
 * process so the harness (which calls `runLoad`) and the user `.load.ts` file
 * CO-RESOLVE the same `@glubean/sdk`, mirroring how `glubean run` spawns the
 * project-local test harness.
 *
 * Why a subprocess at all: running `runLoad` in-process against a user file that
 * resolves a DIFFERENT `@glubean/sdk` instance (a globally-installed CLI vs. a
 * project with its own, non-deduped sdk) split-brains the SDK runtime carrier —
 * the scenario reads one AsyncLocalStorage carrier while `runLoad` installs
 * another. Spawning the project-local runner via tsx makes both halves resolve
 * the project's sdk, eliminating the hazard.
 *
 * This module owns the PARENT side (`runLoadFileInSubprocess`) plus the small
 * pure helpers the child `load-harness` shares (`collectLoadPlans`,
 * `withProcessEnvFallback`) and the wire-message contract between them
 * (`WIRE_PREFIX` / `LoadHarnessMessage`) — kept here as a single source of truth
 * so producer and consumer can't drift.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LoadArtifact, LoadHttpConfig, LoadPlan } from "@glubean/sdk/load";
import { resolveRunnerRoot, resolveTsxPath, prepareZeroProject } from "../runner-resolve.js";

// ── Shared wire contract (child stdout → parent) ─────────────────────────────

/**
 * Marker prefixed to every harness protocol line on stdout. The user's load file
 * + plugins share stdout, whose `console.log` may itself print JSON; gating on
 * this token stops a stray `{"type":"error",...}` log from spoofing an outcome or
 * a failure. It leads with the ASCII Unit Separator (0x1F) — a control byte that
 * ordinary text logs never emit — so collision is negligible. Lines without it
 * are forwarded to the parent's stdout as ordinary user output.
 *
 * (stdout, not a dedicated fd: tsx re-spawns an inner node process and forwards
 * only fd 0/1/2, so an extra protocol fd wouldn't reach the harness.)
 */
export const WIRE_PREFIX = "\x1fglubean-load-wire\x1f";

/**
 * One NDJSON line (after `WIRE_PREFIX`) emitted by `load-harness`. `artifact`
 * carries a completed plan's finalized `LoadArtifact`; `error` carries a per-file
 * import failure or a per-plan run failure; `done` is the terminal sentinel
 * proving the harness finished its own logic cleanly (its absence at child exit
 * means the child crashed before completing).
 */
export type LoadHarnessMessage =
  | { type: "artifact"; runnerId: string; artifact: LoadArtifact }
  | { type: "error"; message: string }
  | { type: "done" };

// ── Shared pure helpers (used by load-harness in the child) ──────────────────

/** A LoadPlan-shaped export: the runnable marker the orchestrator consumes. */
function isLoadPlan(value: unknown): value is LoadPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __glubean_type?: unknown }).__glubean_type === "load-runner"
  );
}

/**
 * Collect every LoadPlan exported by a module namespace (flattening `.each()`
 * arrays of plans).
 */
export function collectLoadPlans(ns: Record<string, unknown>): LoadPlan[] {
  const plans: LoadPlan[] = [];
  for (const value of Object.values(ns)) {
    if (isLoadPlan(value)) {
      plans.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) if (isLoadPlan(v)) plans.push(v);
    }
  }
  return plans;
}

/**
 * Wrap an env map so a missing key falls back to `process.env` — the same
 * shell/CI env semantics the test harness gives `ctx.vars` / `ctx.secrets`, so
 * `BASE_URL=... glubean load ...` resolves even without a `.env` entry.
 *
 * Applied INSIDE the child (which inherits the parent's `process.env`): the
 * parent ships the raw resolved `{ vars, secrets }` over stdin — a Proxy can't
 * survive JSON serialization, so the fallback must be re-established where
 * `process.env` is actually present. Spreading the proxy (for `ctx.vars.all()`)
 * still yields only the explicit map's own keys, not the whole environment.
 */
export function withProcessEnvFallback(map: Record<string, string>): Record<string, string> {
  // Parity with the test harness's env proxy: an empty/nullish map value is
  // treated as MISSING and falls back to process.env (so `BASE_URL=` in .env plus
  // `BASE_URL=... glubean load` resolves), and process.env empties read as unset.
  return new Proxy(map, {
    get(target, prop) {
      if (typeof prop === "string") {
        const value = target[prop];
        if (value !== undefined && value !== null && value !== "") return value;
        return process.env[prop] || undefined;
      }
      return Reflect.get(target, prop);
    },
    has(target, prop) {
      return Reflect.has(target, prop) || (typeof prop === "string" && process.env[prop] !== undefined);
    },
  });
}

// ── Parent side: spawn the child harness ─────────────────────────────────────

/** One plan's completed run, parsed from the child's `artifact` message. */
export interface LoadSubprocessOutcome {
  runnerId: string;
  artifact: LoadArtifact;
}

/** A per-file or per-plan failure, parsed from the child's `error` message. */
export interface LoadSubprocessError {
  message: string;
}

/** Result of running one `.load.ts` file in a child process. */
export interface RunLoadFileResult {
  outcomes: LoadSubprocessOutcome[];
  errors: LoadSubprocessError[];
}

/** Which execution provider the child harness drives each plan through (proposal §5).
 *  Absent → the default single-process `in-process` path (`runLoad`); `multi-core` runs the
 *  coordinator (`runLoadMultiCore`) which spawns `workerCount` worker child processes. */
export type LoadProviderChoice = { kind: "in-process" } | { kind: "multi-core"; workerCount: number };

/** Options for a single-file subprocess load run. */
export interface RunLoadFileOptions {
  /** Resolved environment vars (raw — env fallback is applied in the child). */
  vars: Record<string, string>;
  /** Resolved secrets (raw — env fallback is applied in the child). */
  secrets: Record<string, string>;
  /** Working dir for the child (the project root) — drives runner resolution. */
  cwd: string;
  /** Execution provider (default: in-process). For `multi-core`, the child harness runs the
   *  coordinator + spawns workers; the parent side (WIRE / artifact collection) is unchanged. */
  provider?: LoadProviderChoice;
  /** glubean.yaml `load.http` default transport config (preferH2 / streamsPerConnection),
   *  passed to the child on argv as JSON. The child's harness layers each plan's own `http`
   *  over it (plan wins per field). Absent → the runner's built-in defaults apply. */
  http?: LoadHttpConfig;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// This module builds to dist/load/subprocess.js; load-harness.js and the runner
// package root sit two and three levels up respectively.
const BUNDLED_DIST_DIR = resolve(__dirname, "..");
const BUNDLED_PKG_ROOT = resolve(__dirname, "..", "..");

/** Parse one prefixed protocol line into a wire message, or null if malformed. */
function parseHarnessLine(line: string): LoadHarnessMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // partial / malformed protocol line — ignore
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const msg = parsed as { type?: unknown; runnerId?: unknown; artifact?: unknown; message?: unknown };
  if (msg.type === "artifact" && typeof msg.runnerId === "string" && msg.artifact && typeof msg.artifact === "object") {
    return { type: "artifact", runnerId: msg.runnerId, artifact: msg.artifact as LoadArtifact };
  }
  if (msg.type === "error" && typeof msg.message === "string") {
    return { type: "error", message: msg.message };
  }
  if (msg.type === "done") return { type: "done" };
  return null;
}

/**
 * Run one `.load.ts` file's plans in a child process and collect their
 * artifacts. Spawns `load-harness.js` (project-local when the project ships a
 * built runner with it, else the CLI's bundled copy) through tsx so the harness
 * and the user file resolve the same `@glubean/sdk`. The raw `{ vars, secrets }`
 * are written to the child's stdin; the child applies the process.env fallback.
 *
 * Mirrors the in-process contract: a file's import failure or a plan's run
 * failure becomes an `errors[]` entry (never throws), so other files/plans still
 * produce results.
 */
export async function runLoadFileInSubprocess(
  file: string,
  opts: RunLoadFileOptions,
): Promise<RunLoadFileResult> {
  const { vars, secrets, cwd } = opts;

  // Resolve the runner the same way `glubean run` does (dual-package hazard fix).
  const resolved = resolveRunnerRoot(cwd, BUNDLED_DIST_DIR, BUNDLED_PKG_ROOT);
  let distDir = resolved.distDir;
  let pkgRoot = resolved.pkgRoot;
  let harnessPath = resolve(distDir, "load-harness.js");
  if (!existsSync(harnessPath)) {
    // The resolved runner predates load support (has harness.js but no
    // load-harness.js). Fall back to the bundled harness so load still runs.
    // (Re-introduces the in-process split-brain only when the project ALSO ships
    // its own non-deduped sdk against a too-old runner — no worse than before,
    // and the common up-to-date case is fully correct. Upgrading the project's
    // @glubean/runner restores shared module identity.)
    distDir = BUNDLED_DIST_DIR;
    pkgRoot = BUNDLED_PKG_ROOT;
    harnessPath = resolve(BUNDLED_DIST_DIR, "load-harness.js");
  }

  const zp = prepareZeroProject(cwd, distDir, pkgRoot);
  try {
    const env: Record<string, string> = { ...process.env, ...zp.env } as Record<string, string>;
    // Multi-core: the harness runs `runLoadMultiCore` (which spawns workers) instead of
    // `runLoad`. The provider choice + worker count ride the argv; everything else (WIRE,
    // artifact collection, crash detection) is identical to the in-process path.
    const providerArgs =
      opts.provider?.kind === "multi-core"
        ? [`--provider=multi-core`, `--workers=${opts.provider.workerCount}`]
        : [];
    // glubean.yaml `load.http` default rides argv as JSON (the child layers each plan's own
    // `http` over it). Omitted when unset → the child applies the runner's built-in defaults.
    const httpArgs = opts.http !== undefined ? [`--http=${JSON.stringify(opts.http)}`] : [];
    const child = spawn("node", [resolveTsxPath(), ...zp.tsxArgs, harnessPath, `--file=${file}`, ...providerArgs, ...httpArgs], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin!.write(JSON.stringify({ vars, secrets }));
    child.stdin!.end();

    const outcomes: LoadSubprocessOutcome[] = [];
    const errors: LoadSubprocessError[] = [];
    let stdoutBuffer = "";
    let sawDone = false;
    const stderrChunks: Buffer[] = [];

    const consumeLine = (line: string): void => {
      if (!line.startsWith(WIRE_PREFIX)) {
        // Ordinary user/plugin output — forward it so nothing is swallowed.
        if (line.length > 0) process.stdout.write(line + "\n");
        return;
      }
      const msg = parseHarnessLine(line.slice(WIRE_PREFIX.length));
      if (!msg) return;
      if (msg.type === "artifact") outcomes.push({ runnerId: msg.runnerId, artifact: msg.artifact });
      else if (msg.type === "error") errors.push({ message: msg.message });
      else sawDone = true; // terminal sentinel: the harness finished cleanly
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    // Forward child stderr LIVE so user/plugin diagnostics (console.error) stay
    // visible as they did in-process, and keep a copy for the crash message.
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });

    await new Promise<void>((resolveClose) => {
      child.on("error", (err) => {
        errors.push({
          message:
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? "NODE_NOT_FOUND: Node.js is not installed. Glubean requires Node.js 20+ to run load plans."
              : `failed to start load subprocess for ${file}: ${err.message}`,
        });
        resolveClose();
      });
      child.on("close", (code, signal) => {
        if (stdoutBuffer) consumeLine(stdoutBuffer);
        // No `done` sentinel ⇒ the child died before finishing (crash / OOM /
        // SIGKILL), even if it already emitted some artifacts. Surface a crash
        // error so a PARTIAL run is never mistaken for a complete one. (A clean
        // import-failure path still emits `done`, so it never lands here.)
        if (!sawDone) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          const how = signal ? `signal ${signal}` : `exit code ${code}`;
          errors.push({
            message: `load subprocess for ${file} did not complete (${how})${stderr ? `:\n${stderr}` : ""}`,
          });
        }
        resolveClose();
      });
    });

    return { outcomes, errors };
  } finally {
    zp.cleanup();
  }
}
