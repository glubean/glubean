/**
 * Dry-run worker entry — runs UNDER tsx (so it can import the user's `.ts` test
 * modules) with the zero-project `--import` hook (so their `@glubean/*` imports
 * resolve). Spawned by `dryRunFiles()` in dry-run-spawn.ts.
 *
 * argv: absolute test-file paths.
 * stdout: ONE line per file `__GLUBEAN_DRYRUN__<json>` with
 * `{ file, shapes, error? }`, streamed as each file completes. The streaming is
 * deliberate: if a later file's body hangs and the parent's watchdog kills this
 * process, the already-emitted files' projections survive. The sentinel prefix
 * isolates our payload from any `console.log` a test module emits at import.
 */

import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extractAliasesFromSource, extractFromSource } from "@glubean/scanner";
import { bootstrap } from "./bootstrap.js";
import { dryRunTest, installDryRunGlobals, type TestShape } from "./dry-run.js";

export const DRY_RUN_SENTINEL = "__GLUBEAN_DRYRUN__";

/** One streamed line: the projection of a single file. */
export interface DryRunFileResult {
  file: string;
  shapes: Array<TestShape & { file: string }>;
  error?: string;
}

/** Duck-type a simple Test object (`{ meta:{id}, type:"simple", fn }`). */
function isSimpleTest(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const t = v as { type?: unknown; fn?: unknown; meta?: { id?: unknown } };
  return t.type === "simple" && typeof t.fn === "function" && typeof t.meta?.id === "string";
}

function emit(rec: DryRunFileResult): void {
  // Synchronous write to fd 1 so a streamed line is flushed to the pipe even if
  // a later file's body calls process.exit() before async stdout would drain.
  writeSync(1, DRY_RUN_SENTINEL + JSON.stringify(rec) + "\n");
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);

  // Neutralize raw I/O globals (e.g. fetch) BEFORE importing user modules, so
  // even import-time or non-ctx I/O performs no real network call.
  installDryRunGlobals();

  // Collect test.extend() aliases across ALL input files (union) up front, so an
  // alias declared in one input file and used by another is still recognized
  // when folding bareBranchCount. (Aliases imported from files OUTSIDE the input
  // set are still covered by the CLI's full-project scan + fold.)
  const srcByFile = new Map<string, string>();
  const aliasSet = new Set<string>();
  // Project-wide aliases collected by the spawn parent (covers helper files
  // outside the input set), unioned with the input files' own aliases.
  try {
    for (const a of JSON.parse(process.env.GLUBEAN_DRYRUN_ALIASES ?? "[]") as string[]) {
      if (typeof a === "string") aliasSet.add(a);
    }
  } catch {
    /* malformed env → fall back to input-file aliases only */
  }
  for (const f of files) {
    try {
      const s = readFileSync(f, "utf8");
      srcByFile.set(f, s);
      for (const a of extractAliasesFromSource(s)) aliasSet.add(a);
    } catch {
      /* unreadable file → its import below will report the error */
    }
  }
  const aliases = [...aliasSet];

  // Run project setup (glubean.setup.ts) first so plugin/matcher registrations
  // are installed before user modules import — same as the harness/load paths.
  // A setup failure is surfaced but doesn't abort: per-file imports still run
  // (and will report their own errors if they depend on the missing setup).
  try {
    await bootstrap(process.cwd());
  } catch (err) {
    emit({ file: "", shapes: [], error: `setup (glubean.setup.ts) failed: ${(err as Error)?.message ?? String(err)}` });
  }

  for (const file of files) {
    const shapes: DryRunFileResult["shapes"] = [];
    try {
      // Static bare-branch counts per export (AST, no execution) so the public
      // dryRunFiles() API folds them into projectionComplete on its own — not
      // only when the CLI patches shapes after a separate scan().
      const bareByExport = new Map<string, number>();
      try {
        const src = srcByFile.get(file) ?? readFileSync(file, "utf8");
        // Pass the union of test.extend() aliases (as the scanner does) so
        // aliased tests still get a bareBranchCount; extractFromSource merges
        // BASE_FNS.
        for (const m of extractFromSource(src, aliases)) {
          if (m.bareBranchCount) bareByExport.set(m.exportName, m.bareBranchCount);
        }
      } catch {
        /* best-effort: a parse failure just means no static signal */
      }

      const mod = await import(pathToFileURL(file).href);
      for (const [exportName, val] of Object.entries(mod)) {
        // `test.each(...)` / `test.pick(...)` export an ARRAY of simple Tests
        // (one per generated row, each with its OWN testId). All rows share one
        // fn body → one shape. Project ONCE from the first row (cheap; avoids
        // re-projecting N times), then emit one entry per testId so a
        // full-snapshot sync covers EVERY generated row (replace would otherwise
        // delete the omitted rows' projections).
        const candidates = Array.isArray(val) ? val.filter(isSimpleTest) : isSimpleTest(val) ? [val] : [];
        if (candidates.length === 0) continue;
        const repShape = await dryRunTest(candidates[0] as Parameters<typeof dryRunTest>[0], {
          exportName,
          bareBranchCount: bareByExport.get(exportName),
        });
        for (const c of candidates) {
          const testId = (c as { meta: { id: string } }).meta.id;
          shapes.push({ file, ...repShape, testId });
        }
      }
      emit({ file, shapes });
    } catch (err) {
      emit({ file, shapes, error: (err as Error)?.message ?? String(err) });
    }
  }
}

// Only run when invoked directly as the spawned entry — NOT when imported (e.g.
// dry-run-spawn imports this module for DRY_RUN_SENTINEL). Without this guard,
// main() would run in the importing process against ITS argv.
const isEntry =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main()
    .then(() => {
      // Exit explicitly once every record is emitted (writeSync already flushed
      // them). Otherwise an open handle left by an imported module / setup (timer,
      // mock server, DB pool) would keep the process alive until the parent's
      // watchdog kills it — making a completed projection appear to hang.
      process.exit(0);
    })
    .catch((err) => {
      emit({ file: "", shapes: [], error: String(err) });
      process.exit(1);
    });
}
