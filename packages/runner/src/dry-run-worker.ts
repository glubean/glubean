/**
 * Dry-run worker entry — runs UNDER tsx (so it can import the user's `.ts` test
 * modules) with the zero-project `--import` hook (so their `@glubean/*` imports
 * resolve). Spawned by `dryRunFiles()` in dry-run-spawn.ts.
 *
 * argv: absolute test-file paths.
 * stdout: one line `__GLUBEAN_DRYRUN__<json>` with `{ shapes, errors }`, where
 * each shape carries its source `file` + `exportName`. The sentinel prefix
 * isolates our payload from any `console.log` a test module emits at import.
 */

import { pathToFileURL } from "node:url";
import { dryRunTest, type TestShape } from "./dry-run.js";

export const DRY_RUN_SENTINEL = "__GLUBEAN_DRYRUN__";

interface WorkerOutput {
  shapes: Array<TestShape & { file: string }>;
  errors: Array<{ file: string; message: string }>;
}

/** Duck-type a simple Test object (`{ meta:{id}, type:"simple", fn }`). */
function isSimpleTest(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const t = v as { type?: unknown; fn?: unknown; meta?: { id?: unknown } };
  return t.type === "simple" && typeof t.fn === "function" && typeof t.meta?.id === "string";
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  const out: WorkerOutput = { shapes: [], errors: [] };

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(file).href);
      for (const [exportName, val] of Object.entries(mod)) {
        if (!isSimpleTest(val)) continue;
        const shape = await dryRunTest(val as Parameters<typeof dryRunTest>[0], { exportName });
        out.shapes.push({ file, ...shape });
      }
    } catch (err) {
      out.errors.push({ file, message: (err as Error)?.message ?? String(err) });
    }
  }

  process.stdout.write(DRY_RUN_SENTINEL + JSON.stringify(out) + "\n");
}

// Only run when invoked directly as the spawned entry — NOT when imported (e.g.
// dry-run-spawn imports this module for DRY_RUN_SENTINEL). Without this guard,
// main() would run in the importing process against ITS argv.
const isEntry =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((err) => {
    const out: WorkerOutput = { shapes: [], errors: [{ file: "", message: String(err) }] };
    process.stdout.write(DRY_RUN_SENTINEL + JSON.stringify(out) + "\n");
    process.exitCode = 1;
  });
}
