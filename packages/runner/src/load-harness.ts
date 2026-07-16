/**
 * Load harness — runs INSIDE the Node.js subprocess (spawned via tsx by
 * `runLoadFileInSubprocess`). The load-execution counterpart to `harness.ts`.
 *
 * Because this harness and the user `.load.ts` file are loaded in the SAME
 * process — and resolved through the SAME project-local runner — both halves
 * co-resolve one `@glubean/sdk`, so `runLoad`'s engine carrier and the scenario's
 * runtime carrier are identical (no split-brain).
 *
 * Protocol:
 *   stdin   ← JSON `{ vars, secrets }` (raw; env fallback applied here)
 *   argv    ← `--file=<absolute path to the .load.ts>`
 *   stdout  → `WIRE_PREFIX`-tagged NDJSON `LoadHarnessMessage` lines: one
 *             `artifact` per completed plan, one `error` per import / plan-run
 *             failure, a terminal `done`. The prefix lets the parent tell protocol
 *             from ordinary user `console.log` (forwarded as-is); writes go through
 *             `writeSync(1, …)` so they flush before exit. A crash (no `done`) is
 *             surfaced by the parent from stderr.
 */
import { parseArgs } from "node:util";
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { bootstrap } from "./bootstrap.js";
import { runLoad } from "./load/orchestrator.js";
import { runLoadMultiCore } from "./load/multicore/coordinator.js";
import {
  collectLoadPlans,
  withProcessEnvFallback,
  WIRE_PREFIX,
  type LoadHarnessMessage,
} from "./load/subprocess.js";

/** Write one protocol message synchronously to stdout (fd 1, flush-safe). The
 *  LEADING newline guarantees the prefix begins a fresh line even when user /
 *  plugin code wrote to stdout WITHOUT a trailing newline (otherwise the message
 *  would be appended to that line and no longer start with the prefix). */
function emit(msg: LoadHarnessMessage): void {
  writeSync(1, "\n" + WIRE_PREFIX + JSON.stringify(msg) + "\n");
}

/** Mark the harness done (terminal sentinel) and exit cleanly. */
function finishClean(): never {
  emit({ type: "done" });
  process.exit(0);
}

// A crash (uncaught error) is reported to stderr and exits nonzero WITHOUT a
// `done` sentinel — the parent detects the missing sentinel and surfaces the
// stderr text as a "did not complete" error, so nothing is silently lost.
function crash(message: string): never {
  process.stderr.write(message + "\n");
  process.exit(1);
}
process.on("uncaughtException", (error) => {
  crash(`load harness crashed: ${error?.stack ?? error?.message ?? String(error)}`);
});
process.on("unhandledRejection", (reason: unknown) => {
  crash(`load harness crashed: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    file: { type: "string" },
    // Execution provider (proposal §5). Absent → in-process (`runLoad`). `multi-core` runs
    // the coordinator, which spawns `--workers` worker processes.
    provider: { type: "string" },
    workers: { type: "string" },
  },
  strict: false,
});

const file = args.file as string | undefined;
if (!file) crash("load harness: missing required --file argument");

const providerKind = (args.provider as string | undefined) ?? "in-process";
// Worker count arrives already clamped by the CLI (cores-1); `shardPlan` clamps it again per
// plan. A bad/absent value falls back to 1 (degenerate single-worker = single-node semantics).
const workerCount = (() => {
  const n = Number(args.workers);
  return Number.isInteger(n) && n >= 1 ? n : 1;
})();

/** Read the full stdin payload (the `{ vars, secrets }` JSON). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

const stdinRaw = await readStdin();
const { vars = {}, secrets = {} } = stdinRaw
  ? (JSON.parse(stdinRaw) as { vars?: Record<string, string>; secrets?: Record<string, string> })
  : {};

// Register project plugins (matchers / protocol adapters) before importing the
// load file, which may use them — same as the test/contract paths.
await bootstrap(process.cwd());

let ns: Record<string, unknown>;
try {
  // tsx (the spawning runtime) transforms full TypeScript; Node resolves the
  // file's bare imports (`@glubean/sdk/load`) relative to the file's location.
  ns = (await import(pathToFileURL(file!).href)) as Record<string, unknown>;
} catch (e) {
  // A handled per-file failure (not a crash): emit the error + the done sentinel.
  emit({
    type: "error",
    message: `failed to import load file ${file}: ${e instanceof Error ? e.message : String(e)} (ensure @glubean/sdk is resolvable from the file)`,
  });
  finishClean();
}

const envVars = withProcessEnvFallback(vars);
const envSecrets = withProcessEnvFallback(secrets);

// Multi-core ONLY: bridge SIGINT/SIGTERM to a cooperative abort the coordinator broadcasts so
// workers drain + finalize cleanly (abort → drain → finalize), then reap them. The in-process
// path installs NO signal listeners — a listener would suppress Node's DEFAULT termination
// (the harness has no other place wired to react), so a CI timeout / SIGTERM would leave the
// single-machine harness running to plan end instead of dying promptly. Keeping listeners out
// of the in-process branch preserves the exact pre-D1-4 single-machine signal behavior.
let runAbort: AbortController | undefined;
if (providerKind === "multi-core") {
  runAbort = new AbortController();
  const onSignal = (): void => runAbort!.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

for (const plan of collectLoadPlans(ns)) {
  try {
    // runLoad / runLoadMultiCore can throw for an invalid plan (traffic-mix, no termination
    // bound, bad bounds) — report it per-plan and keep going so other plans' completed
    // artifacts still emit. Multi-core additionally spawns + reaps its own workers.
    const artifact =
      providerKind === "multi-core"
        ? await runLoadMultiCore(plan, {
            file: file!,
            workerCount,
            cwd: process.cwd(),
            vars: envVars,
            secrets: envSecrets,
            ...(runAbort !== undefined ? { abort: runAbort.signal } : {}),
          })
        : await runLoad(plan, { vars: envVars, secrets: envSecrets });
    emit({ type: "artifact", runnerId: plan.id, artifact });
  } catch (e) {
    emit({
      type: "error",
      message: `load plan "${plan.id}" (${file}) failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

finishClean();
