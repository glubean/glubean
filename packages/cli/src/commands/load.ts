/**
 * `glubean load [target]` — run performance plans (M4-c).
 *
 * Discovers `loadRunner()` exports in `.load.ts` files, runs each through the
 * closed-model orchestrator (`@glubean/runner` `runLoad`), writes each finalized
 * `LoadArtifact` to `.glubean/<runnerId>.load.result.json`, prints a per-plan
 * summary, and exits non-zero if any plan's `summary.pass` is false (a crash or a
 * breached threshold). This is the dedicated load path — separate from
 * `glubean run` (the per-test ProjectRunner), since load's execution model differs.
 *
 * KNOWN LIMITATION (in-process MVP — subprocess parity is a tracked follow-on):
 * the user `.load.ts` is imported IN-PROCESS and `runLoad` is the CLI's bundled
 * `@glubean/runner`/`@glubean/sdk`. When the SDK the load file resolves and the
 * SDK `runLoad` uses are the SAME instance — a local/workspace (deduped) install,
 * the dev-time common case — the shared runtime carrier works correctly. A
 * GLOBALLY-installed CLI run against a project with its OWN, non-deduped
 * `@glubean/sdk` can split-brain the runtime carrier (configure()/plugins). The
 * fix is subprocess execution with project resolution, as `glubean run` does;
 * until then prefer a local CLI install for load.
 */
import { resolve, dirname } from "node:path";
import { stat, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { bootstrap, loadProjectEnv, runLoad } from "@glubean/runner";
import type { LoadArtifact, LoadPlan } from "@glubean/sdk/load";
import { resolveEnvFileName } from "../lib/active_env.js";
import { findProjectConfig } from "./run.js";

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

/** A LoadPlan-shaped export: the runnable marker the orchestrator consumes. */
function isLoadPlan(value: unknown): value is LoadPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __glubean_type?: unknown }).__glubean_type === "load-runner"
  );
}

/** Collect every LoadPlan exported by a module namespace (flattening `.each()`
 *  arrays of plans). */
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
 * `BASE_URL=... glubean load ...` resolves even without a `.env` entry. Spreading
 * the proxy (for `ctx.vars.all()`) still yields only the explicit map's own keys,
 * not the whole environment.
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

/**
 * Import each load file, run every plan it exports, and collect the artifacts.
 * A single file's import failure is recorded as a per-file error and the rest
 * still run — completed artifacts are never discarded because a LATER file is
 * broken. Free of fs writes / process exit / printing so it is unit-testable.
 */
export async function runLoadFiles(
  files: string[],
  opts: {
    vars: Record<string, string>;
    secrets: Record<string, string>;
    now?: () => number;
  },
): Promise<RunLoadFilesResult> {
  const outcomes: LoadRunOutcome[] = [];
  const errors: LoadFileError[] = [];
  for (const file of files) {
    let ns: Record<string, unknown>;
    try {
      // Import through tsx so full TypeScript (enums, parameter properties, …) is
      // transformed — the published CLI runs as plain Node, whose strip-only TS
      // would reject non-erasable syntax. Node still resolves the file's bare
      // imports (`@glubean/sdk/load`) relative to the FILE's location, so a
      // monorepo package target resolves even when the cwd has no node_modules.
      ns = (await tsImport(pathToFileURL(file).href, import.meta.url)) as Record<string, unknown>;
    } catch (e) {
      errors.push({
        file,
        message:
          `failed to import load file ${file}: ${e instanceof Error ? e.message : String(e)} ` +
          `(ensure @glubean/sdk is installed/resolvable from the file; a scratch/zero-project ` +
          `checkout without node_modules is not yet supported for load)`,
      });
      continue; // keep going so earlier/later files still produce results
    }
    for (const plan of collectLoadPlans(ns)) {
      try {
        // runLoad can throw for an invalid plan (traffic-mix, no termination
        // bound, bad bounds) — record it per-plan and keep going so other plans'
        // completed artifacts are still produced + persisted.
        const artifact = await runLoad(plan, {
          vars: opts.vars,
          secrets: opts.secrets,
          ...(opts.now ? { now: opts.now } : {}),
        });
        outcomes.push({ file, runnerId: plan.id, artifact });
      } catch (e) {
        errors.push({
          file,
          message: `load plan "${plan.id}" (${file}) failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
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

/** Print a one-plan summary line block. */
function printOutcome(o: LoadRunOutcome): void {
  const s = o.artifact.summary;
  const verdict = s.pass
    ? `${colors.green}PASS${colors.reset}`
    : `${colors.red}FAIL${colors.reset}`;
  console.log(`${colors.bold}${o.runnerId}${colors.reset}  ${verdict}`);
  console.log(
    `${colors.dim}  iterations ${s.totalIterations} (ok ${s.successfulIterations}, failed ${s.failedIterations})` +
      `  errorRate ${pct(s.errorRate)}  p95 ${Math.round(s.latency.p95)}ms` +
      `  throughput ${s.throughputPerSec.toFixed(1)}/s${colors.reset}`,
  );
  for (const t of s.thresholds) {
    const mark = t.pass ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    const where = t.target ? `${t.scope}[${t.target}]` : t.scope;
    console.log(`${colors.dim}  ${mark} ${where}.${t.metric} ${t.expression} (actual ${t.actual})${colors.reset}`);
  }
}

/** Options for the `load` command. */
export interface LoadCommandOptions {
  /** Env file basename (default: the active env, else `.env`). */
  envFile?: string;
}

/**
 * `glubean load [target]` — discover + run load plans under `target` (a file,
 * directory, or glob; defaults to the cwd), write results, and exit non-zero if
 * any plan fails.
 */
export async function loadCommand(
  target: string | undefined,
  options: LoadCommandOptions = {},
): Promise<void> {
  console.log(`\n${colors.bold}${colors.blue}⚡ Glubean Load${colors.reset}\n`);

  const files = await resolveLoadFiles(target ?? process.cwd());
  if (files.length === 0) {
    console.log(
      `${colors.yellow}No .load.ts files found${target ? ` for "${target}"` : ` in ${process.cwd()}`}.${colors.reset}`,
    );
    process.exit(1);
  }

  // Derive the project root from the discovered file (not the shell cwd) so a
  // targeted run outside cwd uses the load file's project for bootstrap / env /
  // `.glubean` output.
  const { rootDir } = await findProjectConfig(dirname(files[0]));

  // An EXPLICIT --env-file that's missing is an error (mirrors `glubean run`) —
  // silently running with empty env could send load to the wrong target / run
  // without credentials. Validate BEFORE bootstrap so a missing file fails fast
  // instead of running project setup code first. A resolved default/active env
  // file may be absent.
  const userSpecifiedEnvFile = options.envFile !== undefined;
  const envFileName = userSpecifiedEnvFile ? options.envFile! : await resolveEnvFileName(rootDir);
  if (userSpecifiedEnvFile && !existsSync(resolve(rootDir, envFileName))) {
    console.log(`${colors.red}Error: env file '${envFileName}' not found in ${rootDir}${colors.reset}`);
    process.exit(1);
  }

  // Plugins (matchers / protocol adapters) must be registered before importing
  // load files that may use them, same as the test/contract paths.
  await bootstrap(rootDir);

  const { vars, secrets } = await loadProjectEnv(rootDir, envFileName);

  // A single file's import failure is collected (not thrown) so earlier/later
  // files still produce + persist results.
  const { outcomes, errors } = await runLoadFiles(files, {
    // process.env fallback so shell/CI-supplied vars/secrets resolve, same as run.
    vars: withProcessEnvFallback(vars),
    secrets: withProcessEnvFallback(secrets),
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

  // Fail if any plan failed, any file errored, or nothing ran at all.
  if (anyFail || errors.length > 0 || outcomes.length === 0) process.exit(1);
}
