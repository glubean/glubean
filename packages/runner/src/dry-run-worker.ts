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

import { pathToFileURL } from "node:url";
import { dryRunTest, type TestShape } from "./dry-run.js";

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
  process.stdout.write(DRY_RUN_SENTINEL + JSON.stringify(rec) + "\n");
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);

  for (const file of files) {
    const shapes: DryRunFileResult["shapes"] = [];
    try {
      const mod = await import(pathToFileURL(file).href);
      for (const [exportName, val] of Object.entries(mod)) {
        // `test.each(...)` / `test.pick(...)` export an ARRAY of simple Tests.
        // Every row shares one fn body, so they share one shape — project the
        // first row as the representative (avoids N duplicate shapes for large
        // datasets) rather than dropping the export entirely.
        const candidate = Array.isArray(val) ? val.find(isSimpleTest) : val;
        if (!isSimpleTest(candidate)) continue;
        const shape = await dryRunTest(candidate as Parameters<typeof dryRunTest>[0], { exportName });
        shapes.push({ file, ...shape });
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
  main().catch((err) => {
    emit({ file: "", shapes: [], error: String(err) });
    process.exitCode = 1;
  });
}
